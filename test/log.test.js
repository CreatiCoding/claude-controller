import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('appendLog: 디렉터리 생성, 타임스탬프·레벨, 5MB 넘으면 .1 로 로테이션', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-log-'));
  process.env.CLAUDE_CONTROLLER_LOG_DIR = dir;
  const { appendLog, tailLines, logPath } = await import(`../src/log.js?${Date.now()}`);
  appendLog('t', 'INFO', '첫 줄');
  appendLog('t', 'WARN', '둘째');
  const lines = tailLines(logPath('t'), 10);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3} \[INFO\] 첫 줄$/);
  assert.match(lines[1], /\[WARN\] 둘째$/);
  fs.writeFileSync(logPath('t'), 'x'.repeat(5 * 1024 * 1024 + 1));
  appendLog('t', 'INFO', '로테이션 후');
  assert.ok(fs.existsSync(logPath('t') + '.1'));
  assert.deepEqual(tailLines(logPath('t'), 10).length, 1);
  fs.rmSync(dir, { recursive: true });
});

test('hook-handler: 데몬이 없으면 무출력 exit 0 이지만 hook.log 에 사유를 남긴다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-hlog-'));
  // 포트 1은 undici가 'bad port'로 막으므로 실제로 아무도 안 듣는 높은 포트를 쓴다
  const env = { ...process.env, CLAUDE_CONTROLLER_LOG_DIR: dir, CLAUDE_CONTROLLER_PORT: '19997' };
  const r = spawnSync(process.execPath, [path.join(ROOT, 'bin/hook-handler.js')], { env, input: JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: 'abcdefgh-1', tool_name: 'Bash' }), encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  const log = fs.readFileSync(path.join(dir, 'hook.log'), 'utf8');
  const hour = String(new Date().getHours()).padStart(2, '0');
  assert.match(log, new RegExp(`^\\d{4}-\\d\\d-\\d\\d ${hour}:\\d\\d:\\d\\d\\.\\d{3} \\[WARN\\]`, 'm'), 'daemon.log와 같은 로컬 시각 형식');
  assert.match(log, /\[WARN\] PermissionRequest sid=abcdefgh tool=Bash → 데몬 없음\(http:\/\/127\.0\.0\.1:19997\/hook\/event\)/);
  const bad = spawnSync(process.execPath, [path.join(ROOT, 'bin/hook-handler.js')], { env, input: '{broken', encoding: 'utf8' });
  assert.equal(bad.status, 0);
  assert.match(fs.readFileSync(path.join(dir, 'hook.log'), 'utf8'), /\[ERROR\] stdin JSON 파싱 실패/);
  fs.rmSync(dir, { recursive: true });
});
