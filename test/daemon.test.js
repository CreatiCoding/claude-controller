// 데몬을 임의 포트로 띄우고 hook-handler → 데몬 → /api/respond 왕복을 검증한다.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import WebSocket from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 19200 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
// PATH를 시스템 기본으로 좁혀 tmux(/opt/homebrew/bin 등)가 안 보이게 한다 — 다이얼 실패 경로를
// 결정적으로 만들고, 테스트가 실제 tmux 세션에 키를 보내는 일을 막는다.
const LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-dlog-'));
const env = { ...process.env, PATH: '/usr/bin:/bin', CLAUDE_CONTROLLER_PORT: String(PORT), CLAUDE_CONTROLLER_HOST: '127.0.0.1', CLAUDE_CONTROLLER_LOG_DIR: LOG_DIR };
let daemon;
let cwd;
let daemonLog = '';

before(async () => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-proj-'));
  daemon = spawn(process.execPath, [path.join(ROOT, 'src/daemon.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    daemon.stdout.on('data', (d) => { daemonLog += d; if (String(d).includes('대기 중')) resolve(); });
    daemon.stderr.on('data', (d) => { daemonLog += d; }); // console.warn/error도 검증 대상
    daemon.on('exit', (c) => reject(new Error(`daemon exited ${c}`)));
    setTimeout(() => reject(new Error('daemon start timeout')), 5000);
  });
});
after(() => { daemon?.kill(); fs.rmSync(cwd, { recursive: true, force: true }); fs.rmSync(LOG_DIR, { recursive: true, force: true }); });

/** hook-handler를 실제 hook처럼 실행: stdin JSON → stdout 출력 */
function hook(payload, extraEnv = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(ROOT, 'bin/hook-handler.js')], { env: { ...env, ...extraEnv } });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('exit', (code) => resolve({ code, out }));
    p.stdin.end(JSON.stringify(payload));
  });
}
const state = async () => (await fetch(`${BASE}/api/state`)).json();
const post = async (p, body) => (await fetch(`${BASE}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
const waitPending = async () => {
  for (let i = 0; i < 50; i++) {
    const s = await state();
    const p = s.sessions.flatMap((x) => x.pending);
    if (p.length) return p[0];
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('pending 없음');
};
const permission = (tool_name, tool_input) =>
  hook({ hook_event_name: 'PermissionRequest', session_id: 'S1', cwd, tool_name, tool_input }, { TMUX_PANE: '%7' });

test('SessionStart → 세션 카드, tmux pane 매핑', async () => {
  const r = await hook({ hook_event_name: 'SessionStart', session_id: 'S1', cwd, source: 'startup' });
  assert.equal(r.code, 0);
  assert.equal(r.out, '', '비허가 이벤트는 무출력');
  const s = (await state()).sessions.find((x) => x.id === 'S1');
  assert.equal(s.status, 'working');
  assert.equal(s.lastEvent, 'start:startup');
});

test('예(once) → allow 출력', async () => {
  const done = permission('Bash', { command: 'ls -la' });
  const p = await waitPending();
  assert.equal((await state()).sessions[0].status, 'waiting');
  assert.deepEqual(await post('/api/respond', { id: p.id, decision: 'once' }), { ok: true, decision: 'once', rule: null });
  const r = await done;
  assert.deepEqual(JSON.parse(r.out), { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
});

test('항상 예 → 규칙 기록 후 allow', async () => {
  const done = permission('Bash', { command: 'git push origin main' });
  const p = await waitPending();
  assert.deepEqual(await post('/api/respond', { id: p.id, decision: 'always' }), { ok: true, decision: 'always', rule: 'Bash(git push *)' });
  assert.equal(JSON.parse((await done).out).hookSpecificOutput.decision.behavior, 'allow');
  const local = JSON.parse(fs.readFileSync(path.join(cwd, '.claude/settings.local.json'), 'utf8'));
  assert.deepEqual(local.permissions.allow, ['Bash(git push *)']);
});

test('항상 예인데 규칙을 못 만들면(복합 명령) once로 강등', async () => {
  const done = permission('Bash', { command: 'cd x && rm -rf y' });
  const p = await waitPending();
  assert.deepEqual(await post('/api/respond', { id: p.id, decision: 'always' }), { ok: true, decision: 'once', rule: null });
  assert.equal(JSON.parse((await done).out).hookSpecificOutput.decision.behavior, 'allow');
});

test('항상 예인데 cwd가 없어 기록할 곳이 없으면 once로 강등 — 폰 응답과 hook 출력이 일치', async () => {
  const done = hook({ hook_event_name: 'PermissionRequest', session_id: 'NOCWD', tool_name: 'Bash', tool_input: { command: 'ls' } });
  const p = await waitPending();
  assert.deepEqual(await post('/api/respond', { id: p.id, decision: 'always' }), { ok: true, decision: 'once', rule: null });
  assert.equal(JSON.parse((await done).out).hookSpecificOutput.decision.behavior, 'allow');
  assert.match(daemonLog, /기록 실패\(cwd=없음\)/);
  assert.match(daemonLog, /\[perm\] 결정: once/);
});

test('아니오 → deny + 메시지', async () => {
  const done = permission('WebFetch', { url: 'https://example.com/x' });
  const p = await waitPending();
  await post('/api/respond', { id: p.id, decision: 'deny' });
  const d = JSON.parse((await done).out).hookSpecificOutput.decision;
  assert.equal(d.behavior, 'deny');
  assert.ok(d.message);
});

test('터미널에서 응답(passthrough) → 무출력, 중복 응답은 ok:false', async () => {
  const done = permission('Read', { file_path: '/etc/hosts' });
  const p = await waitPending();
  await post('/api/respond', { id: p.id, decision: 'passthrough' });
  assert.equal((await done).out, '');
  assert.equal((await post('/api/respond', { id: p.id, decision: 'once' })).ok, false);
  assert.equal((await post('/api/respond', { id: p.id, decision: 'bogus' })).error !== undefined, true);
});

test('매크로패드 키 1은 가장 오래된 요청에 once, 대기 없으면 409', async () => {
  const res = await fetch(`${BASE}/api/key`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"key":1}' });
  assert.equal(res.status, 409);
  const done = permission('Bash', { command: 'pwd' });
  await waitPending();
  assert.equal((await post('/api/key', { key: 1 })).decision, 'once');
  assert.equal(JSON.parse((await done).out).hookSpecificOutput.decision.behavior, 'allow');
});

test('WebSocket: 접속 즉시 스냅샷, 변경 시 브로드캐스트', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const messages = [];
  const got = (n) => new Promise((r) => { const t = setInterval(() => { if (messages.length >= n) { clearInterval(t); r(); } }, 10); });
  ws.on('message', (m) => messages.push(JSON.parse(m)));
  await got(1);
  assert.equal(messages[0].type, 'state');
  await hook({ hook_event_name: 'Notification', session_id: 'S1', cwd, notification_type: 'idle_prompt', message: '끝' });
  await got(2);
  const s = messages.at(-1).sessions.find((x) => x.id === 'S1');
  assert.equal(s.status, 'input');
  assert.equal(s.lastMessage, '끝');
  ws.close();
});

test('Notification(permission_prompt): 우리 hook이 잡고 있지 않을 때만 입력 대기', async () => {
  const done = permission('Bash', { command: 'pwd' });
  const p = await waitPending();
  await hook({ hook_event_name: 'Notification', session_id: 'S1', cwd, notification_type: 'permission_prompt', message: '허가 필요' });
  assert.equal((await state()).sessions.find((x) => x.id === 'S1').status, 'waiting', '폰 카드가 떠 있으면 waiting 유지');
  await post('/api/respond', { id: p.id, decision: 'passthrough' });
  await done;
  await hook({ hook_event_name: 'Notification', session_id: 'S1', cwd, notification_type: 'permission_prompt', message: '허가 필요' });
  assert.equal((await state()).sessions.find((x) => x.id === 'S1').status, 'input', 'passthrough 뒤 터미널 프롬프트 = 입력 대기');
});

test('다이얼: tmux pane은 알지만 tmux 실행이 실패하면 500이 아니라 ok:false', async () => {
  const r = await post('/api/action', { action: 'escape', sessionId: 'S1' });
  assert.equal(r.ok, false);
  assert.match(r.error, /tmux/);
  assert.equal((await post('/api/action', { action: 'escape', sessionId: 'nope' })).ok, false);
});

test('CSRF: text/plain simple request와 다른 Origin은 거부, 같은 Origin은 허용', async () => {
  const raw = (headers, body = '{"key":1}') => fetch(`${BASE}/api/key`, { method: 'POST', headers, body });
  assert.equal((await raw({ 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await raw({ 'Content-Type': 'application/json', Origin: 'http://evil.example' })).status, 403);
  assert.equal((await raw({ 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${PORT}` })).status, 409, '같은 Origin은 통과(대기 없음이라 409)');
  assert.equal((await raw({ 'Content-Type': 'application/json', Origin: 'null' })).status, 403, 'Origin: null도 거부');
  // DNS 리바인딩: Host와 Origin이 서로 같아도 데몬이 열어 둔 주소가 아니면 거부.
  // fetch()는 사용자 지정 Host를 버리므로 node:http + setHost:false로 실제 Host 헤더를 보낸다.
  const rawHost = (host, extra = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/api/key', method: 'POST', setHost: false,
      headers: { 'Content-Type': 'application/json', Host: host, ...extra } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end('{"key":1}');
  });
  assert.equal(await rawHost(`evil.example:${PORT}`, { Origin: `http://evil.example:${PORT}` }), 403, 'Host==Origin이어도 허용 목록 밖이면 거부');
  assert.equal(await rawHost(`evil.example:${PORT}`), 403, 'Origin 없이 Host만 위조해도 거부');
  assert.equal(await rawHost(`LOCALHOST:${PORT}`), 409, 'localhost(대소문자 무관)는 허용');
  assert.equal(await rawHost(`[::1]:${PORT}`), 409, '[::1]도 허용');
  assert.equal(await rawHost('127.0.0.1'), 403, '포트 생략은 80/443이 아니면 거부');
  assert.equal((await raw({ 'Content-Type': 'application/json' }, '{broken')).status, 400);
  assert.equal((await raw({ 'Content-Type': 'application/json' }, '{"x":"' + 'a'.repeat(1_100_000) + '"}')).status, 413);
  assert.equal((await raw({ 'Content-Type': 'application/json' }, '{"x":"' + '한'.repeat(400_000) + '"}')).status, 413, '한도는 바이트 기준(한글 40만 자 = 1.2MB)');
  assert.equal((await raw({ 'Content-Type': 'application/json' }, 'null')).status, 400, '객체가 아닌 JSON은 400');
  assert.equal((await raw({ 'Content-Type': 'application/json' }, '{"key":true}')).status, 409, '숫자가 아니면 409(강제 변환 없음)');
  // GET도 같은 검사: DNS 리바인딩 페이지가 /api/state를 폴링하지 못하게
  const getState = (host) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/api/state', method: 'GET', setHost: false, headers: { Host: host } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(await getState(`evil.example:${PORT}`), 403);
  assert.equal(await getState(`127.0.0.1:${PORT}`), 200);
});

test('Stop → idle, SessionEnd → ended, 미인식 이벤트는 로그, 세션 없음도 무해', async () => {
  await hook({ hook_event_name: 'Stop', session_id: 'S1', cwd });
  assert.equal((await state()).sessions.find((x) => x.id === 'S1').status, 'idle');
  await hook({ hook_event_name: 'SomethingNew', session_id: 'S1', cwd });
  assert.match(daemonLog, /미인식 이벤트: SomethingNew/);
  assert.equal((await hook({ hook_event_name: 'Stop' })).code, 0, 'session_id 없어도 exit 0');
  assert.match(daemonLog, /session_id 없는 페이로드/);
  await hook({ hook_event_name: 'SessionEnd', session_id: 'S1', cwd, reason: 'exit' });
  assert.equal((await state()).sessions.find((x) => x.id === 'S1').status, 'ended');
  // 늦게 도착한 Stop은 종료 상태를 되살리지 않는다
  await hook({ hook_event_name: 'Stop', session_id: 'S1', cwd });
  assert.equal((await state()).sessions.find((x) => x.id === 'S1').status, 'ended');
  // 같은 id로 SessionStart(resume)가 오면 다시 살아난다
  await hook({ hook_event_name: 'SessionStart', session_id: 'S1', cwd, source: 'resume' });
  assert.equal((await state()).sessions.find((x) => x.id === 'S1').status, 'working');
});

test('종료 세션에 허가 요청이 오면 되살아나고(고아 pending 방지), 중복 SessionEnd는 updatedAt을 다시 찍지 않는다', async () => {
  await hook({ hook_event_name: 'SessionEnd', session_id: 'S1', cwd, reason: 'exit' });
  const first = (await state()).sessions.find((x) => x.id === 'S1');
  await new Promise((r) => setTimeout(r, 5));
  await hook({ hook_event_name: 'SessionEnd', session_id: 'S1', cwd, reason: 'exit' });
  assert.equal((await state()).sessions.find((x) => x.id === 'S1').updatedAt, first.updatedAt);
  const done = hook({ hook_event_name: 'PermissionRequest', session_id: 'S1', cwd: '/new/cwd', tool_name: 'Bash', tool_input: { command: 'pwd' } }, { TMUX_PANE: '%9' });
  const p = await waitPending();
  const revived = (await state()).sessions.find((x) => x.id === 'S1');
  assert.equal(revived.status, 'waiting');
  assert.equal(revived.cwd, '/new/cwd', '되살아날 때 새 cwd 반영');
  assert.equal(revived.hasTmux, true);
  await post('/api/respond', { id: p.id, decision: 'once' });
  await done;
  assert.equal((await state()).sessions.find((x) => x.id === 'S1').status, 'working');
});

test('WebSocket 업그레이드도 허용 목록 밖 Origin은 403', async () => {
  const bad = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { Origin: 'http://evil.example' } });
  const err = await new Promise((resolve) => { bad.on('error', resolve); bad.on('open', () => resolve(null)); });
  assert.ok(err, '연결이 거부되어야 함');
  assert.match(err.message, /403/);
  const good = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { Origin: `http://127.0.0.1:${PORT}` } });
  await new Promise((resolve, reject) => { good.on('open', resolve); good.on('error', reject); });
  good.close();
});

test('hook 이벤트 본문은 8MB까지 허용(대용량 Write content), 초과는 413 → 무출력 + 데몬 로그', async () => {
  const big = '한글🙂'.repeat(300_000); // 멀티바이트 — 청크 경계에서 깨지지 않아야 한다
  const r = await hook({ hook_event_name: 'Notification', session_id: 'S1', cwd, notification_type: 'other', message: big });
  assert.equal(r.code, 0);
  const shown = (await state()).sessions.find((x) => x.id === 'S1').lastMessage;
  assert.ok(shown.startsWith(big.slice(0, 3990)) && /\(\+\d+자\)$/.test(shown), '표시용 스냅샷은 4000자 + 접미사');
  assert.ok(!shown.includes('\uFFFD'), 'UTF-8 청크 경계 깨짐 없음');
  const huge = await hook({ hook_event_name: 'PermissionRequest', session_id: 'S1', cwd, tool_name: 'Write', tool_input: { content: 'x'.repeat(9_000_000) } });
  assert.equal(huge.code, 0);
  assert.equal(huge.out, '', '413이면 passthrough');
  assert.match(daemonLog, /\[hook\] 413/);
  // 큰 toolInput은 규칙 생성엔 원본, 스냅샷엔 트리밍
  const done = permission('MultiEdit', { file_path: '/tmp/a', content: 'y'.repeat(100_000), edits: [{ new_string: '🙂'.repeat(5000) }] });
  const p = await waitPending();
  assert.ok(p.toolInput.content.length < 4100);
  assert.match(p.toolInput.content, /\+96000자\)$/);
  assert.ok(p.toolInput.edits[0].new_string.length < 4100, '중첩 필드도 트리밍');
  assert.ok(!p.toolInput.edits[0].new_string.includes('\uFFFD') && !/[\uD800-\uDBFF]…/.test(p.toolInput.edits[0].new_string), '서로게이트 쌍 보호');
  await post('/api/respond', { id: p.id, decision: 'deny' });
  await done;
});

test('/api/key: 1~3 범위의 비정수는 409, 대기 요청을 소비하지 않는다', async () => {
  const done = permission('Bash', { command: 'pwd' });
  await waitPending();
  const res = await fetch(`${BASE}/api/key`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"key":1.5}' });
  assert.equal(res.status, 409);
  assert.equal((await state()).sessions.flatMap((s) => s.pending).length, 1, '요청이 남아 있어야 함');
  await post('/api/key', { key: 3 });
  assert.equal(JSON.parse((await done).out).hookSpecificOutput.decision.behavior, 'deny');
});

test('파일 로그: daemon.log 에 이벤트·결정, hook.log 에 결정과 소요 시간이 남는다', () => {
  const d = fs.readFileSync(path.join(LOG_DIR, 'daemon.log'), 'utf8');
  assert.match(d, /\[INFO\] \[daemon\] 시작 pid=\d+/);
  assert.match(d, /\[INFO\] \[hook\] SessionStart sid=S1/);
  assert.match(d, /\[INFO\] \[perm\] 응답 always→once req=/, '강등이 로그에 남는다');
  assert.match(d, /\[WARN\] \[http\] 403 POST \/api\/key/);
  assert.match(d, /\[INFO\] \[ws\] 접속 /);
  const h = fs.readFileSync(path.join(LOG_DIR, 'hook.log'), 'utf8');
  assert.match(h, /PermissionRequest sid=S1 tool=Bash → once \(\d+\.\ds\)/);
  assert.match(h, /PermissionRequest sid=S1 tool=WebFetch → deny/);
  assert.match(h, /→ 데몬 413 .* — 무시/);
});

test('데몬이 없으면 hook은 무출력 exit 0 (fail-open)', async () => {
  const r = await hook({ hook_event_name: 'PermissionRequest', session_id: 'X', tool_name: 'Bash' }, { CLAUDE_CONTROLLER_PORT: '1' });
  assert.equal(r.code, 0);
  assert.equal(r.out, '');
});
