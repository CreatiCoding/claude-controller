// Claude Code hook 등록/제거 로직. scripts/install-hooks.js·uninstall-hooks.js와 CLI(bin/claude-controller.js)가 공유한다.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ROOT } from './config.js';

export const HOME_DIR = path.join(os.homedir(), '.claude-controller');
export const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
export const BACKUP = SETTINGS + '.claude-controller.bak';
const SRC_HANDLER = path.join(ROOT, 'bin', 'hook-handler.js');

// 허가 대기형인 PermissionRequest만 타임아웃을 길게 준다(데몬 대기 300s + 여유).
export const EVENTS = [
  { event: 'PermissionRequest', timeout: 3600 },
  { event: 'Stop', timeout: 10 },
  { event: 'Notification', timeout: 10 },
  { event: 'SessionStart', timeout: 10 },
  { event: 'SessionEnd', timeout: 10 },
];

export const isOurs = (h) => typeof h?.command === 'string' && h.command.includes('hook-handler.js');

/** npx/yarn dlx 캐시처럼 언제 사라질지 모르는 경로에서 실행 중인가 */
export function isEphemeralInstall(root = ROOT) {
  return /node_modules|_npx|[\\/]\.yarn[\\/]|[\\/]\.cache[\\/]|[\\/]tmp[\\/]/i.test(root);
}

/**
 * hook이 실행할 handler 경로를 정한다. 리포에서 직접 쓰면 리포 안 파일을, npx/dlx처럼
 * 임시 경로면 ~/.claude-controller/hook-handler.js 로 복사해 그 경로를 쓴다(캐시가 지워져도 hook이 살아 있게).
 */
export function resolveHandlerPath({ copy = isEphemeralInstall() } = {}) {
  if (!copy) return SRC_HANDLER;
  fs.mkdirSync(HOME_DIR, { recursive: true });
  const dest = path.join(HOME_DIR, 'hook-handler.js');
  fs.copyFileSync(SRC_HANDLER, dest);
  fs.copyFileSync(path.join(ROOT, 'shell', 'ccode.sh'), path.join(HOME_DIR, 'ccode.sh'));
  return dest;
}

export function readConfigPort() {
  for (const p of [path.join(ROOT, 'config.json'), path.join(HOME_DIR, 'config.json')]) {
    try {
      const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (Number.isInteger(cfg.port)) return cfg.port;
    } catch { /* 없거나 깨짐 → 다음 */ }
  }
  return 9200;
}

/** ~/.claude/settings.json 에 hook을 등록한다. 기존 설정은 보존, 이 도구의 항목만 갱신. */
export function installHooks({ copy, log = console.log } = {}) {
  const handler = resolveHandlerPath({ copy });
  const node = process.execPath; // hook 실행 시 PATH에 node가 없어도 되도록 절대경로
  const port = readConfigPort();
  const command = (port === 9200 ? '' : `CLAUDE_CONTROLLER_PORT=${port} `) + `"${node}" "${handler}"`;

  let settings = {};
  if (fs.existsSync(SETTINGS)) {
    settings = JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); // 파싱 실패면 여기서 던져 아무것도 바꾸지 않는다
    fs.copyFileSync(SETTINGS, BACKUP);
    log(`백업 생성: ${BACKUP}`);
  }
  settings.hooks ??= {};
  for (const { event, timeout } of EVENTS) {
    const groups = (settings.hooks[event] ??= []);
    for (const g of groups) g.hooks = (g.hooks ?? []).filter((h) => !isOurs(h));
    settings.hooks[event] = groups.filter((g) => g.hooks.length > 0);
    settings.hooks[event].push({ hooks: [{ type: 'command', command, timeout }] });
  }
  fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
  fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n');
  log(`hook 등록 완료: ${SETTINGS}`);
  log(`handler: ${handler}`);
  log(`등록된 이벤트: ${EVENTS.map((e) => e.event).join(', ')}`);
  if (port !== 9200) log(`데몬 포트 ${port} (config.json) — Karabiner/Hammerspoon/vite 프록시의 9200은 직접 바꿔야 합니다`);
  log('적용은 새로 시작하는 Claude Code 세션부터입니다.');
  return { handler, command, port };
}

/** 이 도구의 hook만 제거한다. */
export function uninstallHooks({ log = console.log } = {}) {
  if (!fs.existsSync(SETTINGS)) {
    log('settings.json이 없습니다. 제거할 것이 없습니다.');
    return 0;
  }
  const settings = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
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
  log(`제거 완료: hook 항목 ${removed}개 삭제`);
  return removed;
}
