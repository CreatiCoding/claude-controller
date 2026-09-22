// 데몬을 임의 포트로 띄우고 hook-handler → 데몬 → /api/respond 왕복을 검증한다.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 19200 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
// PATH를 시스템 기본으로 좁혀 tmux(/opt/homebrew/bin 등)가 안 보이게 한다 — 다이얼 실패 경로를
// 결정적으로 만들고, 테스트가 실제 tmux 세션에 키를 보내는 일을 막는다.
const env = { ...process.env, PATH: '/usr/bin:/bin', CLAUDE_CONTROLLER_PORT: String(PORT), CLAUDE_CONTROLLER_HOST: '127.0.0.1' };
let daemon;
let cwd;
let daemonLog = '';

before(async () => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-proj-'));
  daemon = spawn(process.execPath, [path.join(ROOT, 'src/daemon.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    daemon.stdout.on('data', (d) => { daemonLog += d; if (String(d).includes('대기 중')) resolve(); });
    daemon.on('exit', (c) => reject(new Error(`daemon exited ${c}`)));
    setTimeout(() => reject(new Error('daemon start timeout')), 5000);
  });
});
after(() => { daemon?.kill(); fs.rmSync(cwd, { recursive: true, force: true }); });

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
  assert.equal((await raw({ 'Content-Type': 'application/json' }, '{broken')).status, 400);
  assert.equal((await raw({ 'Content-Type': 'application/json' }, '{"x":"' + 'a'.repeat(1_100_000) + '"}')).status, 413);
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

test('데몬이 없으면 hook은 무출력 exit 0 (fail-open)', async () => {
  const r = await hook({ hook_event_name: 'PermissionRequest', session_id: 'X', tool_name: 'Bash' }, { CLAUDE_CONTROLLER_PORT: '1' });
  assert.equal(r.code, 0);
  assert.equal(r.out, '');
});
