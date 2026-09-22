// `claude-controller doctor`: 새 환경에서 이 도구가 동작할지 진단한다.
// 각 검사는 { name, status: 'ok'|'warn'|'fail'|'info', detail, fix? } 를 돌려준다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import config, { ROOT } from './config.js';
import { SETTINGS, EVENTS, isOurs, HOME_DIR, installHooks } from './hooks-install.js';
import { logPath, tailLines } from './log.js';

const MIN_NODE = [20, 19];

function which(cmd) {
  try {
    return execFileSync('/usr/bin/which', [cmd], { encoding: 'utf8', timeout: 3000 }).trim() || null;
  } catch { return null; }
}
function version(cmd, args = ['--version']) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', timeout: 5000 }).trim().split('\n')[0];
  } catch { return null; }
}

/** 명령 문자열 "ENV=x "node" "handler"" 에서 따옴표 경로들을 뽑는다 */
function quotedPaths(command) {
  return [...String(command).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

async function fetchState(port) {
  const res = await fetch(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(2000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function portOwner(port) {
  try {
    const out = execFileSync('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8', timeout: 5000 });
    const line = out.trim().split('\n')[1];
    return line ? line.split(/\s+/).slice(0, 2).join(' ') : null;
  } catch { return null; }
}

/** hook-handler를 실제 hook처럼 실행해 데몬 왕복이 되는지 본다 */
function runHook(handler, payload, port) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [handler], { env: { ...process.env, CLAUDE_CONTROLLER_PORT: String(port) } });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('exit', (code) => resolve({ code, out }));
    p.on('error', () => resolve({ code: -1, out }));
    p.stdin.end(JSON.stringify(payload));
    setTimeout(() => p.kill(), 5000).unref();
  });
}

/** 자동 수정 가능한 항목에 붙는 fixer: () => Promise<string>(무엇을 했는지). --fix 에서만 실행된다. */
export async function runChecks({ port = config.port } = {}) {
  const checks = [];
  const add = (name, status, detail, fix, fixer) => checks.push({ name, status, detail, ...(fix ? { fix } : {}), ...(fixer ? { fixer } : {}) });
  const reinstallHooks = async () => {
    const r = installHooks({ log: () => {} });
    return `hook 재등록 (${r.handler})`;
  };

  // 1. Node
  const [maj, min] = process.versions.node.split('.').map(Number);
  const nodeOk = maj > MIN_NODE[0] || (maj === MIN_NODE[0] && min >= MIN_NODE[1]);
  add('Node.js', nodeOk ? 'ok' : 'fail', `v${process.versions.node} (${process.execPath})`,
    nodeOk ? undefined : `Node ${MIN_NODE.join('.')} 이상이 필요합니다`);

  // 2. claude CLI
  const claudePath = which('claude');
  add('Claude Code CLI', claudePath ? 'ok' : 'fail', claudePath ? `${claudePath} — ${version('claude') ?? '버전 확인 실패'}` : 'PATH에 claude 없음',
    claudePath ? undefined : 'Claude Code를 설치하세요: npm i -g @anthropic-ai/claude-code');

  // 3. 대시보드 빌드
  const dist = path.join(ROOT, 'dist', 'index.html');
  const vite = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  add('대시보드 빌드(dist/)', fs.existsSync(dist) ? 'ok' : 'fail', fs.existsSync(dist) ? dist : `${dist} 없음`,
    fs.existsSync(dist) ? undefined : '리포에서 `yarn build`(npm 패키지라면 재설치)',
    !fs.existsSync(dist) && fs.existsSync(vite) ? async () => {
      execFileSync(process.execPath, [vite, 'build'], { cwd: ROOT, stdio: 'ignore', timeout: 120_000 });
      return 'vite build 실행';
    } : undefined);

  // 4. config
  const cfgPaths = [path.join(ROOT, 'config.json'), path.join(HOME_DIR, 'config.json')].filter((p) => fs.existsSync(p));
  for (const p of cfgPaths) {
    try { JSON.parse(fs.readFileSync(p, 'utf8')); add('config.json', 'ok', p); }
    catch (e) { add('config.json', 'fail', `${p} 파싱 실패: ${e.message}`, 'JSON 문법을 고치세요(파싱 실패 시 기본값으로 동작)'); }
  }
  if (!cfgPaths.length) add('config.json', 'info', '없음 — 기본값 사용 (port 9200, host auto)');
  if (config.host === '0.0.0.0') add('바인딩 host', 'warn', '0.0.0.0 — 같은 네트워크의 누구나 승인 API에 접근 가능', 'config.json의 host를 auto로');

  // 5. hook 등록
  let settings = null;
  if (!fs.existsSync(SETTINGS)) {
    add('Claude Code hook 등록', 'fail', `${SETTINGS} 없음`, '`claude-controller install-hooks` 실행', reinstallHooks);
  } else {
    try { settings = JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); }
    catch (e) { add('Claude Code hook 등록', 'fail', `${SETTINGS} 파싱 실패: ${e.message}`, 'settings.json JSON 문법을 고치세요'); }
  }
  let handlerPath = null;
  if (settings) {
    const missing = EVENTS.map((e) => e.event).filter((ev) => !(settings.hooks?.[ev] ?? []).some((g) => (g.hooks ?? []).some(isOurs)));
    const ours = (settings.hooks?.PermissionRequest ?? []).flatMap((g) => g.hooks ?? []).find(isOurs);
    if (!ours) {
      add('Claude Code hook 등록', 'fail', 'PermissionRequest hook에 hook-handler가 없음', '`claude-controller install-hooks` 실행', reinstallHooks);
    } else {
      add('Claude Code hook 등록', missing.length ? 'warn' : 'ok', missing.length ? `누락 이벤트: ${missing.join(', ')}` : `${EVENTS.length}개 이벤트 등록됨`,
        missing.length ? '`claude-controller install-hooks` 재실행' : undefined, missing.length ? reinstallHooks : undefined);
      const [nodeInCmd, handler] = quotedPaths(ours.command);
      handlerPath = handler ?? null;
      // node 절대경로가 아직 존재하는가 (brew upgrade·nvm 정리로 사라지면 hook이 조용히 죽는다)
      add('hook의 node 경로', nodeInCmd && fs.existsSync(nodeInCmd) ? 'ok' : 'fail', nodeInCmd ?? '(없음)',
        nodeInCmd && fs.existsSync(nodeInCmd) ? undefined : 'node가 사라짐(brew upgrade 등) — `claude-controller install-hooks` 재실행',
        nodeInCmd && fs.existsSync(nodeInCmd) ? undefined : reinstallHooks);
      if (nodeInCmd && nodeInCmd !== process.execPath && fs.existsSync(nodeInCmd)) {
        add('hook의 node 경로', 'info', `현재 node(${process.execPath})와 다름 — 동작에는 문제 없음`);
      }
      add('hook-handler 파일', handler && fs.existsSync(handler) ? 'ok' : 'fail', handler ?? '(없음)',
        handler && fs.existsSync(handler) ? undefined : 'handler가 사라짐(리포 이동·npx 캐시 정리) — `claude-controller install-hooks` 재실행',
        handler && fs.existsSync(handler) ? undefined : reinstallHooks);
      // 복사본이면 원본과 같은가
      const src = path.join(ROOT, 'bin', 'hook-handler.js');
      if (handler && fs.existsSync(handler) && path.resolve(handler) !== path.resolve(src) && fs.existsSync(src)) {
        const same = fs.readFileSync(handler, 'utf8') === fs.readFileSync(src, 'utf8');
        add('hook-handler 최신 여부', same ? 'ok' : 'warn', same ? '복사본이 현재 버전과 일치' : '복사본이 현재 버전과 다름', same ? undefined : '`claude-controller install-hooks` 재실행', same ? undefined : reinstallHooks);
      }
      const m = /CLAUDE_CONTROLLER_PORT=(\d+)/.exec(ours.command);
      const hookPort = m ? Number(m[1]) : 9200;
      if (hookPort !== port) add('hook 포트', 'fail', `hook은 ${hookPort}, 데몬 설정은 ${port}`, '`claude-controller install-hooks` 재실행으로 포트를 맞추세요', reinstallHooks);
      const timeout = ours.timeout ?? 0;
      if (timeout < config.permissionWaitSeconds) add('hook 타임아웃', 'warn', `PermissionRequest hook timeout ${timeout}s < permissionWaitSeconds ${config.permissionWaitSeconds}s`, 'hook 타임아웃이 먼저 끊어 passthrough 됩니다 — install-hooks 재실행', reinstallHooks);
    }
  }

  // 6. 데몬
  let state = null;
  try {
    state = await fetchState(port);
    add('데몬(127.0.0.1)', 'ok', `http://127.0.0.1:${port} 응답, 세션 ${state.sessions.length}개`);
  } catch (e) {
    const owner = portOwner(port);
    if (owner) add('데몬(127.0.0.1)', 'fail', `포트 ${port}를 다른 프로세스가 사용 중(${owner}) — 데몬이 아니거나 응답 없음(${e.message})`, 'config.json의 port를 바꾸고 install-hooks 재실행, 또는 그 프로세스를 종료');
    else add('데몬(127.0.0.1)', 'warn', `포트 ${port}에 데몬 없음`, '`claude-controller start`(리포에서는 `yarn start`)로 데몬을 띄우세요');
  }

  // 7. hook 왕복 (데몬이 떠 있고 handler가 있을 때)
  const handlerForTest = handlerPath && fs.existsSync(handlerPath) ? handlerPath : path.join(ROOT, 'bin', 'hook-handler.js');
  if (state && fs.existsSync(handlerForTest)) {
    const sid = `doctor-${Date.now()}`;
    const r = await runHook(handlerForTest, { hook_event_name: 'SessionStart', session_id: sid, cwd: process.cwd(), source: 'doctor' }, port);
    let seen = false;
    try { seen = (await fetchState(port)).sessions.some((s) => s.id === sid); } catch { /* 아래에서 실패 처리 */ }
    await runHook(handlerForTest, { hook_event_name: 'SessionEnd', session_id: sid, reason: 'doctor' }, port);
    add('hook → 데몬 왕복', seen && r.code === 0 ? 'ok' : 'fail', seen ? 'SessionStart 이벤트가 데몬에 도착' : `이벤트가 데몬에 도착하지 않음 (exit ${r.code})`,
      seen ? undefined : 'hook-handler와 데몬 포트가 맞는지, 데몬 로그에 403/413이 없는지 확인');
  }

  // 8. 폰 연결 경로
  const ifaces = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const i of list ?? []) {
      if (i.family === 'IPv4' && config.autoBindSubnets.some((p) => i.address.startsWith(p))) ifaces.push(`${name}=${i.address}`);
    }
  }
  let wifi = null;
  try {
    const txt = execFileSync('/usr/sbin/networksetup', ['-listallhardwareports'], { encoding: 'utf8', timeout: 5000 });
    wifi = txt.match(/Hardware Port: (?:Wi-Fi|AirPort)\nDevice: (\S+)/)?.[1] ?? null;
  } catch { /* 비-macOS */ }
  add('Wi-Fi 인터페이스 식별', wifi ? 'ok' : 'warn', wifi ? `${wifi} (테더링 대역이어도 바인딩 제외)` : 'networksetup으로 Wi-Fi 포트를 찾지 못함',
    wifi ? undefined : 'config.json excludeInterfaces에 Wi-Fi 인터페이스 이름(en0 등)을 직접 적으세요');
  if (ifaces.length) {
    const usable = ifaces.filter((s) => !wifi || !s.startsWith(`${wifi}=`));
    add('아이폰 USB 테더링', usable.length ? 'ok' : 'warn', usable.length ? `감지: ${usable.join(', ')}` : `테더링 대역이 Wi-Fi(${wifi})에만 있음: ${ifaces.join(', ')}`,
      usable.length ? undefined : '아이폰을 USB로 연결하고 개인용 핫스팟을 켜세요');
  } else {
    add('아이폰 USB 테더링', 'info', '테더링 인터페이스 없음 (아이폰을 쓰지 않으면 무시)');
  }
  const adb = which('adb');
  if (adb) {
    const devices = version('adb', ['devices']) === null ? null : (() => {
      try { return execFileSync('adb', ['devices'], { encoding: 'utf8', timeout: 8000 }).trim().split('\n').slice(1).filter(Boolean); } catch { return null; }
    })();
    add('안드로이드 adb', devices?.length ? 'ok' : 'info', devices?.length ? `기기 ${devices.length}대: ${devices.join(' | ')}` : `${adb} 있음, 연결된 기기 없음`);
  } else {
    add('안드로이드 adb', 'info', '없음 (안드로이드를 쓰지 않으면 무시) — brew install android-platform-tools');
  }

  // 9. 선택 도구
  const tmux = which('tmux');
  add('tmux (다이얼 기능)', tmux ? 'ok' : 'info', tmux ? `${tmux} — ${version('tmux', ['-V']) ?? ''}` : '없음 — 다이얼(모델 전환·생각 토글)만 안 됨');
  const karabiner = fs.existsSync('/Applications/Karabiner-Elements.app');
  const rule = path.join(os.homedir(), '.config/karabiner/assets/complex_modifications/claude-controller.json');
  if (karabiner) add('Karabiner 규칙 (매크로패드)', fs.existsSync(rule) ? 'ok' : 'warn', fs.existsSync(rule) ? rule : '규칙 파일 미복사', fs.existsSync(rule) ? undefined : '`claude-controller install-hooks`가 복사합니다 (또는 ADVANCED_MACROPAD.md)',
    fs.existsSync(rule) ? undefined : async () => { fs.mkdirSync(path.dirname(rule), { recursive: true }); fs.copyFileSync(path.join(ROOT, 'karabiner', 'claude-controller.json'), rule); return `Karabiner 규칙 복사 → ${rule}`; });
  else add('Karabiner (매크로패드)', 'info', '없음 (매크로패드를 쓰지 않으면 무시)');

  // 10. 셸 함수
  const rc = ['.zshrc', '.bashrc', '.bash_profile'].map((f) => path.join(os.homedir(), f)).filter((f) => fs.existsSync(f));
  const rcText = Object.fromEntries(rc.map((f) => [f, fs.readFileSync(f, 'utf8')]));
  const sourced = rc.some((f) => /ccode\.sh|claude-controller shell-init/.test(rcText[f]));
  // 옛 이름(cl.sh)을 source하는 줄이 남아 있으면 셸 시작마다 "no such file" 오류가 난다
  const STALE = /^(\s*(?:source|\.)\s+)(\S*)\/cl\.sh(.*)$/m;
  const stale = rc.filter((f) => STALE.test(rcText[f]));
  if (stale.length) {
    add('ccode 셸 함수', 'warn', `옛 이름 cl.sh를 source하는 줄이 남아 있음: ${stale.join(', ')}`, '그 줄을 `source …/shell/ccode.sh`로 바꾸세요 (`doctor --fix`가 백업 후 바꿔 줍니다)',
      async () => {
        const done = [];
        for (const f of stale) {
          fs.copyFileSync(f, `${f}.claude-controller.bak`);
          const fixed = rcText[f].replace(new RegExp(STALE.source, 'gm'), (line, pre, dir, rest) => {
            // 같은 폴더에 ccode.sh가 있으면 이름만 바꾸고, 없으면(리포가 옮겨짐) 현재 리포의 ccode.sh로
            const candidate = path.join(dir, 'ccode.sh');
            return `${pre}${fs.existsSync(candidate) ? candidate : path.join(ROOT, 'shell', 'ccode.sh')}${rest}`;
          });
          fs.writeFileSync(f, fixed);
          done.push(f);
        }
        return `rc 파일의 cl.sh → ccode.sh (${done.join(', ')}, 백업 *.claude-controller.bak)`;
      });
  } else {
    add('ccode 셸 함수', sourced ? 'ok' : 'info', sourced ? 'rc 파일에서 ccode.sh를 source함' : 'rc 파일에 ccode.sh source 없음 — `claude`로 직접 실행해도 허가 응답은 동작');
  }

  // 11. 로그 — 최근 오류·경고 요약 (원인 추적의 출발점)
  for (const name of ['daemon', 'hook']) {
    const file = logPath(name);
    if (!fs.existsSync(file)) { add(`로그 ${name}.log`, 'info', `${file} 없음 (아직 실행된 적 없음)`); continue; }
    const recent = tailLines(file, 300);
    const bad = recent.filter((l) => /\[(WARN|ERROR|FATAL)\]/.test(l));
    const last = recent.at(-1) ?? '';
    const size = (fs.statSync(file).size / 1024).toFixed(0);
    add(`로그 ${name}.log`, bad.length ? 'warn' : 'ok',
      `${file} (${size}KB) 최근 300줄 중 경고/오류 ${bad.length}건${bad.length ? ` — 마지막: ${bad.at(-1).slice(0, 160)}` : ''}${!bad.length && last ? ` — 마지막 줄: ${last.slice(0, 100)}` : ''}`,
      bad.length ? `\`claude-controller logs --${name}\` 로 전체 확인` : undefined);
  }

  return checks;
}

const ICON = { ok: '✅', warn: '⚠️ ', fail: '❌', info: 'ℹ️ ' };

export function formatChecks(checks) {
  const lines = [];
  for (const c of checks) {
    lines.push(`${ICON[c.status]} ${c.name}: ${c.detail}`);
    if (c.fix) lines.push(`     → ${c.fix}`);
  }
  const fails = checks.filter((c) => c.status === 'fail').length;
  const warns = checks.filter((c) => c.status === 'warn').length;
  lines.push('');
  lines.push(fails ? `실패 ${fails}개, 경고 ${warns}개 — 위 → 안내를 따르세요` : warns ? `실패 없음, 경고 ${warns}개` : '모든 검사 통과');
  return lines.join('\n');
}

/** CLI 진입: 종료 코드는 fail이 하나라도 있으면 1 */
export async function doctorMain(args = []) {
  const json = args.includes('--json');
  let checks = await runChecks();
  let applied = [];
  if (args.includes('--fix')) {
    // 실패·경고 중 fixer가 있는 것만, 같은 fixer(hook 재등록)는 한 번만 실행
    const seen = new Set();
    for (const c of checks) {
      if (!c.fixer || !['fail', 'warn'].includes(c.status) || seen.has(c.fixer)) continue;
      seen.add(c.fixer);
      try { applied.push({ name: c.name, result: await c.fixer() }); }
      catch (e) { applied.push({ name: c.name, error: e.message }); }
    }
    if (applied.length) checks = await runChecks(); // 고친 뒤 다시 검사
  }
  const strip = (c) => { const { fixer, ...rest } = c; return { ...rest, fixable: Boolean(fixer) }; };
  if (json) console.log(JSON.stringify({ applied, checks: checks.map(strip) }, null, 2));
  else {
    if (applied.length) {
      console.log('자동 수정:');
      for (const a of applied) console.log(a.error ? `  ❌ ${a.name}: ${a.error}` : `  🔧 ${a.name}: ${a.result}`);
      console.log('');
    } else if (args.includes('--fix')) {
      console.log('자동으로 고칠 항목 없음\n');
    }
    console.log(formatChecks(checks));
    const fixable = checks.filter((c) => c.fixer && ['fail', 'warn'].includes(c.status));
    if (fixable.length && !args.includes('--fix')) console.log(`\n${fixable.length}개 항목은 \`claude-controller doctor --fix\` 로 자동 수정할 수 있습니다: ${fixable.map((c) => c.name).join(', ')}`);
  }
  return checks.some((c) => c.status === 'fail') ? 1 : 0;
}
