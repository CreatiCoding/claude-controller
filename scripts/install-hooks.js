#!/usr/bin/env node
// ~/.claude/settings.json 에 claude-controller hook을 등록한다.
// 기존 설정은 보존하고, 이 리포의 hook-handler 항목만 갱신(중복 제거 후 추가)한다.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HANDLER = path.join(ROOT, 'bin', 'hook-handler.js');
const NODE = process.execPath; // hook 실행 시 PATH에 node가 없어도 되도록 절대경로 사용
const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');

// 허가 대기형인 PermissionRequest만 타임아웃을 길게 준다(데몬 대기 300s + 여유).
const EVENTS = [
  { event: 'PermissionRequest', timeout: 3600 },
  { event: 'Stop', timeout: 10 },
  { event: 'Notification', timeout: 10 },
  { event: 'SessionStart', timeout: 10 },
  { event: 'SessionEnd', timeout: 10 },
];

const command = `"${NODE}" "${HANDLER}"`;

let settings = {};
if (fs.existsSync(SETTINGS)) {
  settings = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
  fs.copyFileSync(SETTINGS, SETTINGS + '.claude-controller.bak');
  console.log(`백업 생성: ${SETTINGS}.claude-controller.bak`);
}
settings.hooks ??= {};

const isOurs = (h) => typeof h.command === 'string' && h.command.includes('hook-handler.js');

for (const { event, timeout } of EVENTS) {
  const groups = (settings.hooks[event] ??= []);
  // 이전 설치 흔적 제거
  for (const g of groups) g.hooks = (g.hooks ?? []).filter((h) => !isOurs(h));
  settings.hooks[event] = groups.filter((g) => g.hooks.length > 0);
  settings.hooks[event].push({ hooks: [{ type: 'command', command, timeout }] });
}

fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n');
console.log(`hook 등록 완료: ${SETTINGS}`);
console.log(`등록된 이벤트: ${EVENTS.map((e) => e.event).join(', ')}`);
console.log('적용은 새로 시작하는 Claude Code 세션부터입니다.');
