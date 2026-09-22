// claude-controller 데몬: hook 수신 + WebSocket 대시보드 + 허가 응답 + tmux 주입
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { WebSocketServer } from 'ws';
import config, { ROOT } from './config.js';
import { Store, SessionStatus } from './state.js';
import { ruleForRequest, addAllowRule } from './permissions.js';
import { sendKeys, typeLine } from './tmux.js';
import { startAdbReverse } from './adb.js';

const store = new Store({ endedTtlMs: config.endedSessionTtlSeconds * 1000 });

// ---------- 정적 파일 (vite 빌드 산출물) ----------
const PUBLIC_DIR = path.join(ROOT, 'dist');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.js': 'text/javascript',
  '.css': 'text/css',
};

function serveStatic(req, res) {
  let name = new URL(req.url, 'http://x').pathname;
  if (name === '/') name = '/index.html';
  const file = path.join(PUBLIC_DIR, path.normalize(name));
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    if (name === '/index.html') {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('대시보드 빌드가 없습니다 — 리포 루트에서 `yarn build`를 먼저 실행하세요.');
      return;
    }
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

// ---------- 유틸 ----------
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function readJson(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let body = '';
    let tooLarge = false;
    req.setEncoding('utf8'); // 청크 경계에서 멀티바이트(한글·이모지)가 U+FFFD로 깨지지 않게
    req.on('data', (c) => {
      if (tooLarge) return; // 나머지는 읽어서 버린다 (소켓을 끊으면 413 응답이 못 나간다)
      body += c;
      if (body.length > limit) { tooLarge = true; body = ''; }
    });
    req.on('end', () => {
      if (tooLarge) return reject(new HttpError(413, `요청 본문이 ${Math.round(limit / 1_000_000)}MB를 넘음`));
      try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new HttpError(400, '본문이 JSON이 아님')); }
    });
    req.on('error', reject);
  });
}

// CSRF 방어: 승인 API에 인증이 없으므로, 브라우저에 열린 임의 페이지가 127.0.0.1(또는 adb reverse된
// 폰의 localhost)로 쏘는 cross-site POST를 막는다. (1) application/json만 받아 preflight 없는
// text/plain simple request를 차단, (2) Origin이 있으면 우리 host와 같아야 한다.
// curl·hook-handler·Karabiner·Hammerspoon은 Origin을 보내지 않으므로 그대로 통과.
// Host/Origin은 "요청의 Host와 같은가"가 아니라 "데몬이 실제로 열어 둔 주소인가"로 본다.
// Host 헤더끼리 비교하면 DNS 리바인딩(evil.example → 127.0.0.1)으로 같은 값이 만들어져 뚫린다.
function allowedHosts() {
  // 루프백 별칭 3개 + 현재 listen 중인 주소 + 고정 host. 0.0.0.0이면 접속 주소가 어느 인터페이스든
  // 될 수 있으므로 이 머신의 IPv4 전부를 넣는다(그 모드는 어차피 "누구나 접근 가능" 경고 대상).
  const names = ['127.0.0.1', 'localhost', '[::1]', ...servers.keys()];
  if (config.host === '0.0.0.0') {
    for (const ifaces of Object.values(os.networkInterfaces())) {
      for (const i of ifaces ?? []) if (i.family === 'IPv4') names.push(i.address);
    }
  } else if (config.host !== 'auto') {
    names.push(config.host);
  }
  const hosts = new Set();
  for (const n of names) {
    hosts.add(`${n}:${config.port}`);
    if (config.port === 80 || config.port === 443) hosts.add(n); // 브라우저는 기본 포트를 생략한다
  }
  return hosts;
}

// Host/Origin이 허용 목록 밖이면 사유 문자열, 아니면 null. POST와 WebSocket 업그레이드가 공유한다.
function crossSiteReason(req) {
  const hosts = allowedHosts();
  const host = String(req.headers.host ?? '').toLowerCase();
  const origin = req.headers.origin;
  if (!hosts.has(host)) return `허용되지 않은 Host: ${host || '(없음)'}`;
  if (origin) {
    let oh = null;
    try { oh = new URL(origin).host.toLowerCase(); } catch { /* 'null' 등 파싱 불가 */ }
    if (oh === null) return `Origin 형식 오류: ${origin}`;
    if (!hosts.has(oh)) return `허용되지 않은 Origin: ${origin}`;
  }
  return null;
}

function rejectCrossSite(req) {
  const ct = String(req.headers['content-type'] ?? '');
  if (!ct.toLowerCase().startsWith('application/json')) {
    throw new HttpError(415, 'Content-Type은 application/json이어야 함');
  }
  const reason = crossSiteReason(req);
  if (reason) {
    // 폰 대시보드의 오류 띠는 5초면 사라지므로, 원인은 데몬 로그에도 남긴다
    console.warn(`[http] 403 ${req.url} — ${reason} (다른 호스트명으로 열었다면 127.0.0.1/테더링 주소로 접속하세요)`);
    throw new HttpError(403, reason);
  }
}


function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

// ---------- hook 이벤트 처리 ----------
// hook 페이로드는 Write/NotebookEdit의 content 전문을 담을 수 있어 한도를 넉넉히 둔다.
// 넘으면 413 → hook-handler는 무출력 종료(passthrough)라 폰에 안 뜨고 터미널 프롬프트로 간다.
const HOOK_BODY_LIMIT = 8_000_000;

async function handleHookEvent(req, res) {
  const { payload = {}, tmuxPane = null } = await readJson(req, HOOK_BODY_LIMIT);
  const event = payload.hook_event_name;
  const sid = payload.session_id;
  if (!sid) {
    console.log(`[hook] session_id 없는 페이로드 무시 (event=${event ?? '(없음)'}) — hook 스키마 변경 여부 확인`);
    return json(res, 400, { error: 'session_id 없음' });
  }

  const base = { cwd: payload.cwd, tmuxPane };

  switch (event) {
    case 'SessionStart':
      store.upsertSession(sid, { ...base, status: SessionStatus.WORKING, lastEvent: `start:${payload.source ?? ''}` });
      return json(res, 200, {});

    case 'SessionEnd':
      if (store.sessions.get(sid)?.endedAt) return json(res, 200, {}); // 중복 SessionEnd는 TTL을 다시 찍지 않는다
      store.upsertSession(sid, base);
      store.endSession(sid, payload.reason);
      return json(res, 200, {});

    case 'Stop':
      // 턴 완료 → 완료 표시. 남은 허가 요청이 있으면 그대로 둔다(없는 게 정상).
      store.upsertSession(sid, { ...base, status: SessionStatus.IDLE, lastEvent: 'stop' });
      return json(res, 200, {});

    case 'Notification': {
      const type = payload.notification_type ?? '';
      const patch = { ...base, lastEvent: `notify:${type}`, lastMessage: payload.message ?? null };
      if (type === 'idle_prompt' || type === 'agent_needs_input') patch.status = SessionStatus.INPUT;
      // passthrough/타임아웃 뒤 터미널에 기본 허가 프롬프트가 떠 있는 상태. 우리 hook이 아직
      // 잡고 있는 요청이 있으면(폰 카드가 떠 있음) 그쪽이 우선이므로 건드리지 않는다.
      if (type === 'permission_prompt' && !store.hasPending(sid)) patch.status = SessionStatus.INPUT;
      store.upsertSession(sid, patch);
      return json(res, 200, {});
    }

    case 'PermissionRequest': {
      // 응답 대기형: 폰/매크로패드의 결정이 올 때까지 이 HTTP 응답을 잡아둔다.
      let timer;
      let pendingId;
      const wait = new Promise((resolve) => {
        // cwd/tmuxPane도 함께 넘긴다 — 종료로 표시된 세션을 되살리는 경우 새 pane/cwd로 갱신돼야
        // 다이얼이 죽은 pane으로 가지 않는다
        const pending = store.addPending({ sessionId: sid, payload, resolve, ...base });
        pendingId = pending.id;
        console.log(`[perm] 대기: ${pending.toolName} ${summarizeInput(pending.toolInput)} (${sid.slice(0, 8)})`);
        timer = setTimeout(
          () => store.resolvePending(pending.id, { decision: 'passthrough', reason: 'timeout' }),
          config.permissionWaitSeconds * 1000,
        );
      });
      // hook 프로세스가 먼저 죽으면(세션 강제 종료 등) 유령 요청을 즉시 정리
      res.on('close', () => {
        if (store.pending.has(pendingId)) {
          console.log('[perm] hook 연결 끊김 — 요청 정리');
          store.resolvePending(pendingId, { decision: 'passthrough', reason: 'disconnected' });
        }
      });
      const decision = await wait;
      clearTimeout(timer);
      console.log(`[perm] 결정: ${decision.decision}${decision.rule ? ` (${decision.rule})` : ''}`);
      return json(res, 200, decision);
    }

    default:
      // 등록하지 않은 이벤트가 와도 활동 갱신용으로만 사용. Claude Code 쪽 hook 스키마가
      // 바뀌어 이름이 달라진 경우를 알아차릴 수 있게 로그를 남긴다.
      console.log(`[hook] 미인식 이벤트: ${event ?? '(없음)'} (${sid.slice(0, 8)})`);
      store.upsertSession(sid, { ...base, lastEvent: event });
      return json(res, 200, {});
  }
}

function summarizeInput(toolInput) {
  if (!toolInput) return '';
  const s = toolInput.command ?? toolInput.file_path ?? toolInput.url ?? JSON.stringify(toolInput);
  return String(s).slice(0, 120);
}

// ---------- 허가 응답 / 다이얼 액션 ----------
function respond(requestId, decisionName) {
  const p = store.pending.get(requestId);
  if (!p) return { ok: false, error: '해당 허가 요청이 없거나 이미 처리됨' };
  const result = { decision: decisionName };
  if (decisionName === 'always') {
    // 규칙을 만들고 실제로 기록한 경우에만 'always'. 복합 명령이라 규칙이 없거나, cwd 없음·
    // settings.local.json 파싱 실패로 기록이 안 되면 1회 승인으로 강등해 "다시 묻지 않기"가
    // 조용히 넓어지거나 조용히 무시되는 두 경우를 모두 막는다. 폰 응답과 hook 출력이 같은
    // 값을 보도록 여기서(응답을 만들기 전에) 결정한다.
    const rule = ruleForRequest(p);
    if (rule && addAllowRule(p.cwd, rule)) {
      result.rule = rule;
    } else {
      console.log(`[perm] allow 규칙 ${rule ? `기록 실패(cwd=${p.cwd ?? '없음'})` : '생성 불가(복합/래퍼 명령)'} — 1회 승인으로 강등`);
      result.decision = 'once';
    }
  }
  store.resolvePending(requestId, result);
  return { ok: true, decision: result.decision, rule: result.rule ?? null };
}

async function dialAction(action, sessionId) {
  const session = sessionId ? store.sessions.get(sessionId) : store.activeSession();
  if (!session?.tmuxPane) return { ok: false, error: 'tmux pane을 아는 활성 세션이 없음 (Claude Code를 tmux 안에서 실행했는지 확인)' };
  if (session.status === SessionStatus.ENDED) return { ok: false, error: '종료된 세션' };

  try {
    return await runDial(action, session);
  } catch (err) {
    // tmux가 PATH에 없거나 pane이 사라진 경우 — 500 대신 실패 사유를 돌려준다
    return { ok: false, error: `tmux 실행 실패: ${err.message}` };
  }
}

async function runDial(action, session) {
  switch (action) {
    case 'thinking_down':
    case 'thinking_up': {
      // 현재 버전의 확장 사고는 토글(Meta+T)이므로 좌/우 모두 토글을 보내고
      // 다이얼 방향을 추정 상태로 기록한다.
      await sendKeys(session.tmuxPane, config.thinkingToggleKey);
      store.upsertSession(session.id, { thinking: action === 'thinking_up', lastEvent: action });
      return { ok: true, action };
    }
    case 'model_cycle': {
      const cycle = config.modelCycle;
      if (!Array.isArray(cycle) || cycle.length === 0) return { ok: false, error: 'config.modelCycle이 비어 있음' };
      const idx = cycle.indexOf(session.model);
      const next = cycle[(idx + 1) % cycle.length];
      await typeLine(session.tmuxPane, `/model ${next}`);
      store.upsertSession(session.id, { model: next, lastEvent: `model:${next}` });
      return { ok: true, model: next };
    }
    case 'escape':
      await sendKeys(session.tmuxPane, 'Escape');
      return { ok: true };
    default:
      return { ok: false, error: `알 수 없는 액션: ${action}` };
  }
}

// 매크로패드(Hammerspoon hyper+1~6) → 액션 매핑
async function handleKey(key) {
  if (!Number.isInteger(key)) return { ok: false, error: `키는 1~6 정수여야 함: ${key}` };
  if (key >= 1 && key <= 3) {
    const p = store.oldestPending();
    if (!p) return { ok: false, error: '대기 중인 허가 요청 없음' };
    return respond(p.id, { 1: 'once', 2: 'always', 3: 'deny' }[key]);
  }
  const action = { 4: 'thinking_down', 5: 'thinking_up', 6: 'model_cycle' }[key];
  if (!action) return { ok: false, error: `키 범위 밖: ${key}` };
  return dialAction(action);
}

// ---------- HTTP 라우팅 ----------
const requestHandler = async (req, res) => {
  try {
    const { pathname } = new URL(req.url, 'http://x');

    if (req.method === 'POST') rejectCrossSite(req);

    if (req.method === 'POST' && pathname === '/hook/event') return await handleHookEvent(req, res);

    if (req.method === 'POST' && pathname === '/api/respond') {
      const { id, decision } = await readJson(req);
      if (!['once', 'always', 'deny', 'passthrough'].includes(decision)) {
        return json(res, 400, { error: 'decision은 once|always|deny|passthrough' });
      }
      return json(res, 200, respond(id, decision));
    }

    if (req.method === 'POST' && pathname === '/api/key') {
      const { key } = await readJson(req);
      const result = await handleKey(Number(key));
      console.log(`[key] ${key} → ${JSON.stringify(result)}`);
      return json(res, result.ok ? 200 : 409, result);
    }

    if (req.method === 'POST' && pathname === '/api/action') {
      const { action, sessionId } = await readJson(req);
      return json(res, 200, await dialAction(action, sessionId));
    }

    if (req.method === 'GET' && pathname === '/api/state') return json(res, 200, store.snapshot());

    if (req.method === 'GET') return serveStatic(req, res);
    json(res, 404, { error: 'not found' });
  } catch (err) {
    if (!(err instanceof HttpError)) console.error('[http]', err);
    // hook 이벤트가 거부되면 hook-handler는 조용히 passthrough하므로("폰에 안 뜸") 데몬 로그에는 남긴다
    else if (req.url === '/hook/event') console.warn(`[hook] ${err.status} ${err.message} — 이 허가 요청은 터미널 프롬프트로 넘어갑니다`);
    if (!res.headersSent) json(res, err.status ?? 500, { error: err.message });
  }
};

// ---------- WebSocket ----------
const wss = new WebSocketServer({ noServer: true });
const upgradeHandler = (req, socket, head) => {
  if (new URL(req.url, 'http://x').pathname !== '/ws') return socket.destroy();
  // WebSocket은 동일 출처 정책이 없어 임의 사이트가 스냅샷(cwd·대기 중 명령)을 읽을 수 있다 — POST와 같은 검사
  const reason = crossSiteReason(req);
  if (reason) {
    console.warn(`[ws] 거부 — ${reason} (다른 호스트명으로 대시보드를 열면 세션이 안 보이고 재접속을 반복합니다)`);
    socket.on('error', () => {});
    socket.once('finish', () => socket.destroy());
    return socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
};

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'state', ...store.snapshot() }));
});

let broadcastQueued = false;
store.onChange = () => {
  if (broadcastQueued) return;
  broadcastQueued = true;
  setImmediate(() => {
    broadcastQueued = false;
    const msg = JSON.stringify({ type: 'state', ...store.snapshot() });
    for (const client of wss.clients) if (client.readyState === 1) client.send(msg);
  });
};

// ---------- 리스닝 (다중 바인딩) ----------
// host:'auto'면 127.0.0.1에 항상 바인딩하고, 폰 USB 테더링 인터페이스
// (아이폰 172.20.10.x / 안드로이드 192.168.42.x)가 나타나면 자동으로 추가 바인딩.
// 케이블을 나중에 꽂아도 붙고, 회사망 인터페이스에는 절대 열지 않는다.
const servers = new Map(); // addr -> http.Server

function listenOn(addr, onReady) {
  if (servers.has(addr)) return;
  const s = http.createServer(requestHandler);
  s.on('upgrade', upgradeHandler);
  s.on('error', (err) => {
    console.error(`[daemon] ${addr}:${config.port} 바인딩 실패: ${err.message}`);
    servers.delete(addr);
    if (addr === '127.0.0.1' || addr === config.host) {
      // 루프백(또는 고정 host)이 없으면 hook-handler가 닿을 수 없어 데몬이 떠 있어도 아무 일도 못 한다.
      console.error(`[daemon] ${addr} 바인딩 없이는 동작할 수 없습니다 — 포트 사용 중인 프로세스를 확인하거나 config.json의 port를 바꾸세요`);
      process.exit(1);
    }
  });
  s.listen(config.port, addr, () => {
    console.log(`[daemon] http://${addr}:${config.port} 에서 대기 중`);
    onReady?.();
  });
  servers.set(addr, s);
}

// 자동 바인딩에서 제외할 인터페이스 이름 집합. 'wifi'는 macOS Wi-Fi 포트 이름으로 치환.
const excludedIfaces = config.host === 'auto' ? resolveExcludedInterfaces(config.excludeInterfaces) : new Set();
function resolveExcludedInterfaces(names) {
  const out = new Set();
  for (const n of names ?? []) {
    if (n !== 'wifi') { out.add(n); continue; }
    try {
      const txt = execFileSync('/usr/sbin/networksetup', ['-listallhardwareports'], { encoding: 'utf8', timeout: 5000 });
      const m = txt.match(/Hardware Port: (?:Wi-Fi|AirPort)\nDevice: (\S+)/);
      if (m) out.add(m[1]);
      else console.warn('[daemon] networksetup 출력에서 Wi-Fi 포트를 찾지 못했습니다 — excludeInterfaces에 인터페이스 이름(en0 등)을 직접 적으세요');
    } catch {
      // networksetup 없음(비-macOS 등) — Wi-Fi 제외를 못 하므로 경고만
      console.warn('[daemon] Wi-Fi 인터페이스를 찾지 못했습니다 — 핫스팟에 Wi-Fi로 붙어 있으면 그 대역에도 바인딩될 수 있습니다');
    }
  }
  return out;
}

function tetherAddrs() {
  const found = [];
  let skipped = false;
  for (const [name, ifaces] of Object.entries(os.networkInterfaces())) {
    for (const i of ifaces ?? []) {
      if (i.family !== 'IPv4' || !config.autoBindSubnets.some((p) => i.address.startsWith(p))) continue;
      if (excludedIfaces.has(name)) { skipped = true; continue; }
      found.push(i.address);
    }
  }
  if (skipped && !tetherAddrs.warned) {
    tetherAddrs.warned = true;
    console.log('[daemon] 테더링 대역이 Wi-Fi 인터페이스에 있어 바인딩하지 않음 — 폰을 USB로 연결하세요');
  }
  return found;
}

function syncBindings() {
  const want = tetherAddrs();
  for (const addr of want) {
    listenOn(addr, () =>
      console.log(`[daemon] 폰 테더링 감지 — 폰 브라우저에서 http://${addr}:${config.port} 접속`));
  }
  // 케이블이 빠져 사라진 인터페이스는 정리
  for (const [addr, s] of servers) {
    if (addr !== '127.0.0.1' && !want.includes(addr)) {
      s.close();
      servers.delete(addr);
      console.log(`[daemon] ${addr} 테더링 해제됨`);
    }
  }
}

if (config.host === 'auto') {
  listenOn('127.0.0.1', () => {
    console.log(`[daemon] 안드로이드: adb reverse 후 폰에서 http://localhost:${config.port}`);
    console.log('[daemon] 아이폰: 개인용 핫스팟 켜고 USB 연결 → 감지되면 접속 주소를 여기 표시');
  });
  syncBindings();
  setInterval(syncBindings, 10_000).unref();
} else {
  if (config.host === '0.0.0.0') {
    console.warn('[daemon] 경고: 모든 인터페이스에 바인딩합니다 — 같은 네트워크의 누구나 승인 API에 접근 가능');
  }
  listenOn(config.host);
  // hook-handler는 항상 127.0.0.1로 붙으므로, 특정 IP만 지정해도 루프백은 유지한다
  if (config.host !== '127.0.0.1' && config.host !== '0.0.0.0') listenOn('127.0.0.1');
}

if (config.adb.enabled) startAdbReverse(config.port, config.adb.intervalSeconds);
