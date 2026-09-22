// CLI(bin/claude-controller.js)와 doctor를 격리된 HOME에서 검증한다. 실제 ~/.claude는 건드리지 않는다.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin/claude-controller.js');
const PORT = 19200 + Math.floor(Math.random() * 1000);
let HOME;
let daemon;

const env = () => ({ ...process.env, HOME, PATH: '/usr/bin:/bin', CLAUDE_CONTROLLER_PORT: String(PORT), CLAUDE_CONTROLLER_HOST: '127.0.0.1', CLAUDE_CONTROLLER_LOG_DIR: path.join(HOME, '.claude-controller', 'logs') });
const run = (args, extra = {}) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...env(), ...extra }, timeout: 30_000 });
const settingsPath = () => path.join(HOME, '.claude', 'settings.json');

before(() => {
  HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-home-'));
  fs.mkdirSync(path.join(HOME, '.claude'));
  // 기존 hook은 보존돼야 한다
  fs.writeFileSync(settingsPath(), JSON.stringify({ model: 'x', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo other', timeout: 5 }] }] } }));
});
after(() => { daemon?.kill(); fs.rmSync(HOME, { recursive: true, force: true }); });

test('help / 알 수 없는 명령', () => {
  assert.match(run(['help']).stdout, /doctor/);
  const r = run(['nope']);
  assert.equal(r.status, 2);
});

test('doctor: 데몬 없음 → 경고, hook 미등록 → 실패(exit 1), --json 출력', () => {
  const r = run(['doctor', '--json']);
  assert.equal(r.status, 1);
  const checks = JSON.parse(r.stdout);
  const byName = Object.fromEntries(checks.map((c) => [c.name, c]));
  assert.equal(byName['Node.js'].status, 'ok');
  assert.equal(byName['Claude Code hook 등록'].status, 'fail');
  assert.equal(byName['데몬(127.0.0.1)'].status, 'warn');
  assert.ok(byName['Claude Code hook 등록'].fix);
});

test('install-hooks --copy: handler를 ~/.claude-controller/에 복사하고 기존 hook 보존, 재실행 시 중복 없음', () => {
  const r = run(['install-hooks', '--copy']);
  assert.equal(r.status, 0, r.stderr);
  const copied = path.join(HOME, '.claude-controller', 'hook-handler.js');
  assert.ok(fs.existsSync(copied));
  assert.ok(fs.existsSync(path.join(HOME, '.claude-controller', 'ccode.sh')));
  assert.ok(fs.existsSync(settingsPath() + '.claude-controller.bak'), '백업 생성');
  const s = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  assert.equal(s.model, 'x', '기존 설정 보존');
  assert.ok(s.hooks.Stop.some((g) => g.hooks.some((h) => h.command === 'echo other')), '기존 hook 보존');
  const ours = s.hooks.PermissionRequest.flatMap((g) => g.hooks).filter((h) => h.command.includes('hook-handler.js'));
  assert.equal(ours.length, 1);
  assert.ok(ours[0].command.includes(copied));
  assert.equal(ours[0].timeout, 3600);
  run(['install-hooks', '--copy']);
  const s2 = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  assert.equal(s2.hooks.PermissionRequest.flatMap((g) => g.hooks).filter((h) => h.command.includes('hook-handler.js')).length, 1, '재실행해도 1개');
});

test('doctor: 데몬 실행 중이면 hook 왕복까지 통과, hook 포트 불일치는 실패로 잡는다', async () => {
  daemon = spawn(process.execPath, [path.join(ROOT, 'src/daemon.js')], { env: env(), stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    daemon.stdout.on('data', (d) => { if (String(d).includes('대기 중')) resolve(); });
    setTimeout(() => reject(new Error('daemon start timeout')), 5000);
  });
  const checks = JSON.parse(run(['doctor', '--json']).stdout);
  const byName = Object.fromEntries(checks.map((c) => [c.name, c]));
  assert.equal(byName['데몬(127.0.0.1)'].status, 'ok');
  assert.equal(byName['hook → 데몬 왕복'].status, 'ok');
  // env로 포트를 바꿨는데 등록된 hook은 9200 → 불일치를 잡아야 한다
  assert.equal(byName['hook 포트'].status, 'fail');
  assert.equal(byName['hook-handler 최신 여부'].status, 'ok');
  // 복사본이 오래되면 경고
  fs.appendFileSync(path.join(HOME, '.claude-controller', 'hook-handler.js'), '\n// stale\n');
  const again = Object.fromEntries(JSON.parse(run(['doctor', '--json']).stdout).map((c) => [c.name, c]));
  assert.equal(again['hook-handler 최신 여부'].status, 'warn');
  // doctor가 만든 세션은 종료 처리돼 있어야 한다
  const st = await (await fetch(`http://127.0.0.1:${PORT}/api/state`)).json();
  assert.ok(st.sessions.every((s) => s.status === 'ended'));
});

test('~/.claude-controller/config.json의 port를 hook 명령에 반영', () => {
  fs.writeFileSync(path.join(HOME, '.claude-controller', 'config.json'), JSON.stringify({ port: 19999 }));
  run(['install-hooks', '--copy']);
  const s = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  const ours = s.hooks.PermissionRequest.flatMap((g) => g.hooks).find((h) => h.command.includes('hook-handler.js'));
  assert.match(ours.command, /^CLAUDE_CONTROLLER_PORT=19999 /);
  fs.rmSync(path.join(HOME, '.claude-controller', 'config.json'));
});

test('uninstall-hooks: 이 도구의 hook만 제거, 기존 hook은 남는다', () => {
  const r = run(['uninstall-hooks']);
  assert.equal(r.status, 0, r.stderr);
  const s = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  assert.equal(s.hooks.PermissionRequest, undefined);
  assert.ok(s.hooks.Stop.some((g) => g.hooks.some((h) => h.command === 'echo other')));
});

test('logs: 데몬·hook 로그 끝부분을 보여주고, doctor가 로그 경고를 요약한다', () => {
  const r = run(['logs', '-n', '500']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /===== .*daemon\.log/);
  assert.match(r.stdout, /\[daemon\] 시작 pid=/);
  assert.equal(run(['logs', '-n', '1', '--daemon']).stdout.trim().split('\n').length, 2, '-n 1 이면 헤더 + 1줄');
  assert.match(r.stdout, /===== .*hook\.log/);
  const only = run(['logs', '--hook']);
  assert.ok(!/daemon\.log/.test(only.stdout));
  const checks = JSON.parse(run(['doctor', '--json']).stdout);
  const logChecks = checks.filter((c) => c.name.startsWith('로그 '));
  assert.equal(logChecks.length, 2);
  // hook.log 는 실패·허가 결정만 기록하므로 doctor 왕복(SessionStart 성공)만으로는 생기지 않을 수 있다 → info 허용
  assert.ok(logChecks.every((c) => ['ok', 'warn', 'info'].includes(c.status)));
  assert.equal(logChecks.find((c) => c.name === '로그 daemon.log').status, 'ok');
});

test('shell-init은 cl 함수를 출력한다', () => {
  assert.match(run(['shell-init']).stdout, /^ccode\(\) \{/m);
});
