import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ruleForRequest, addAllowRule } from '../src/permissions.js';

const bash = (command) => ({ toolName: 'Bash', toolInput: { command } });

test('Bash: 서브명령이 있는 명령은 두 토큰 프리픽스', () => {
  assert.equal(ruleForRequest(bash('git push origin main')), 'Bash(git push *)');
  assert.equal(ruleForRequest(bash('npm run build')), 'Bash(npm run *)');
  assert.equal(ruleForRequest(bash('gh pr create --fill')), 'Bash(gh pr *)');
});

test('Bash: 일반 명령은 첫 토큰, 앞쪽 env 대입은 무시', () => {
  assert.equal(ruleForRequest(bash('ls -la')), 'Bash(ls *)');
  assert.equal(ruleForRequest(bash('FOO=1 BAR=2 make test')), 'Bash(make test *)');
  assert.equal(ruleForRequest(bash('git -C /x status')), 'Bash(git *)'); // 두 번째 토큰이 옵션이면 한 토큰
});

test('Bash: 복합 명령(파이프·체인·리다이렉트·서브셸)은 규칙을 만들지 않는다', () => {
  for (const c of ['cd x && git push', 'cat a | sh', 'a; b', 'echo hi > f', 'echo $(rm -rf /)', 'x || y', 'a\nb']) {
    assert.equal(ruleForRequest(bash(c)), null, c);
  }
});

test('Bash: sudo/env 같은 래퍼는 규칙을 만들지 않는다', () => {
  assert.equal(ruleForRequest(bash('sudo git push')), null);
  assert.equal(ruleForRequest(bash('env FOO=1 ls')), null);
  assert.equal(ruleForRequest(bash('bash -c ls')), null);
});

test('WebFetch: 도메인 규칙, URL 파싱 실패 시 도구 전체', () => {
  assert.equal(ruleForRequest({ toolName: 'WebFetch', toolInput: { url: 'https://github.com/a/b' } }), 'WebFetch(domain:github.com)');
  assert.equal(ruleForRequest({ toolName: 'WebFetch', toolInput: { url: 'not a url' } }), 'WebFetch');
});

test('그 외 도구는 도구명, unknown은 null', () => {
  assert.equal(ruleForRequest({ toolName: 'Edit', toolInput: { file_path: '/a' } }), 'Edit');
  assert.equal(ruleForRequest({ toolName: 'unknown', toolInput: null }), null);
  assert.equal(ruleForRequest({ toolName: null, permissionType: 'Read' }), 'Read');
});

test('addAllowRule: settings.local.json에 병합 저장, 중복 없음, cwd 없으면 false', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-perm-'));
  assert.equal(addAllowRule(cwd, 'Bash(git push *)'), true);
  assert.equal(addAllowRule(cwd, 'Bash(git push *)'), true);
  const file = path.join(cwd, '.claude', 'settings.local.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { permissions: { allow: ['Bash(git push *)'] } });
  assert.equal(addAllowRule(null, 'Bash(ls *)'), false);
  // 깨진 파일은 덮어쓰지 않는다
  fs.writeFileSync(file, '{broken');
  assert.equal(addAllowRule(cwd, 'Bash(ls *)'), false);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
  // 쓰기 실패(읽기 전용 디렉터리)도 예외 대신 false
  const ro = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ro-'));
  fs.chmodSync(ro, 0o555);
  assert.equal(addAllowRule(ro, 'Bash(ls *)'), false);
  fs.chmodSync(ro, 0o755);
  fs.rmSync(ro, { recursive: true });
  // cwd가 사라졌으면 되살리지 않는다
  fs.rmSync(cwd, { recursive: true });
  assert.equal(addAllowRule(cwd, 'Bash(ls *)'), false);
  assert.equal(fs.existsSync(cwd), false);
});
