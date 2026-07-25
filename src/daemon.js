// claude-controller 데몬: hook 수신 + WebSocket 대시보드 + 허가 응답 + tmux 주입
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import config, { ROOT } from './config.js';
import { Store, SessionStatus } from './state.js';
import { ruleForRequest, addAllowRule } from './permissions.js';
import { sendKeys, typeLine } from './tmux.js';
import { startAdbReverse } from './adb.js';

const store = new Store({ endedTtlMs: config.endedSessionTtlSeconds * 1000 });

// ---------- 정적 파일 ----------
const PUBLIC_DIR = path.join(ROOT, 'public');
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
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

// ---------- 유틸 ----------
function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1_000_000) req.destroy(); });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

// ---------- hook 이벤트 처리 ----------
async function handleHookEvent(req, res) {
  const { payload = {}, tmuxPane = null } = await readJson(req);
  const event = payload.hook_event_name;
  const sid = payload.session_id;
  if (!sid) return json(res, 400, { error: 'session_id 없음' });

  const base = { cwd: payload.cwd, tmuxPane };

  switch (event) {
    case 'SessionStart':
      store.upsertSession(sid, { ...base, status: SessionStatus.WORKING, lastEvent: `start:${payload.source ?? ''}` });
      return json(res, 200, {});

    case 'SessionEnd':
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
      store.upsertSession(sid, patch);
      return json(res, 200, {});
    }

    case 'PermissionRequest': {
      // 응답 대기형: 폰/매크로패드의 결정이 올 때까지 이 HTTP 응답을 잡아둔다.
      store.upsertSession(sid, { ...base, lastEvent: 'permission' });
      let timer;
      let pendingId;
      const wait = new Promise((resolve) => {
        const pending = store.addPending({ sessionId: sid, payload, resolve });
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

      if (decision.decision === 'always' && decision.rule) {
        addAllowRule(payload.cwd, decision.rule);
      }
      console.log(`[perm] 결정: ${decision.decision}`);
      return json(res, 200, decision);
    }

    default:
      // 등록하지 않은 이벤트가 와도 활동 갱신용으로만 사용
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
    result.rule = ruleForRequest(p);
    if (!result.rule) result.decision = 'once'; // 규칙을 못 만들면 1회 승인으로 강등
  }
  store.resolvePending(requestId, result);
  return { ok: true, decision: result.decision, rule: result.rule ?? null };
}

async function dialAction(action, sessionId) {
  const session = sessionId ? store.sessions.get(sessionId) : store.activeSession();
  if (!session?.tmuxPane) return { ok: false, error: 'tmux pane을 아는 활성 세션이 없음 (Claude Code를 tmux 안에서 실행했는지 확인)' };

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
    console.error('[http]', err);
    if (!res.headersSent) json(res, 500, { error: err.message });
  }
};

// ---------- WebSocket ----------
const wss = new WebSocketServer({ noServer: true });
const upgradeHandler = (req, socket, head) => {
  if (new URL(req.url, 'http://x').pathname !== '/ws') return socket.destroy();
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
  });
  s.listen(config.port, addr, () => {
    console.log(`[daemon] http://${addr}:${config.port} 에서 대기 중`);
    onReady?.();
  });
  servers.set(addr, s);
}

function tetherAddrs() {
  const found = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces ?? []) {
      if (i.family === 'IPv4' && config.autoBindSubnets.some((p) => i.address.startsWith(p))) {
        found.push(i.address);
      }
    }
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
}

if (config.adb.enabled) startAdbReverse(config.port, config.adb.intervalSeconds);
