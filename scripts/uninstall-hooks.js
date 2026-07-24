#!/usr/bin/env node
// ~/.claude/settings.json 에서 claude-controller hook 등록을 제거한다.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
if (!fs.existsSync(SETTINGS)) {
  console.log('settings.json이 없습니다. 제거할 것이 없습니다.');
  process.exit(0);
}

const settings = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
const isOurs = (h) => typeof h.command === 'string' && h.command.includes('hook-handler.js');

let removed = 0;
for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
  for (const g of groups) {
    const before = (g.hooks ?? []).length;
    g.hooks = (g.hooks ?? []).filter((h) => !isOurs(h));
    removed += before - g.hooks.length;
  }
  settings.hooks[event] = groups.filter((g) => (g.hooks ?? []).length > 0);
  if (settings.hooks[event].length === 0) delete settings.hooks[event];
}
if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;

fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n');
console.log(`제거 완료: hook 항목 ${removed}개 삭제`);
