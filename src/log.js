// 파일 로그. 데몬은 stdout/stderr에도 그대로 찍고, 같은 줄을 ~/.claude-controller/logs/<name>.log 에 남긴다.
// 터미널을 닫아도 원인을 추적할 수 있게 하는 것이 목적. 5MB를 넘으면 .1 로 한 번 굴린다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const LOG_DIR = process.env.CLAUDE_CONTROLLER_LOG_DIR || path.join(os.homedir(), '.claude-controller', 'logs');
const MAX_BYTES = 5 * 1024 * 1024;

export function logPath(name) {
  return path.join(LOG_DIR, `${name}.log`);
}

function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function rotateIfNeeded(file) {
  try {
    if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, `${file}.1`);
  } catch { /* 없음 */ }
}

/** 한 줄을 파일에 덧붙인다. 로그 때문에 본 기능이 죽으면 안 되므로 모든 실패를 삼킨다. */
export function appendLog(name, level, message) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const file = logPath(name);
    rotateIfNeeded(file);
    fs.appendFileSync(file, `${stamp()} [${level}] ${message}\n`);
  } catch { /* 로그 실패는 무시 */ }
}

function fmt(args) {
  return args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? (a.stack ?? a.message) : JSON.stringify(a))).join(' ');
}

/**
 * console.log/warn/error 를 감싸 파일에도 남긴다. 데몬 코드의 기존 console 호출을 그대로 살리기 위한 방식.
 * 반환값은 원래 console 함수들(테스트에서 복구용).
 */
export function installConsoleLogger(name) {
  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...a) => { orig.log(...a); appendLog(name, 'INFO', fmt(a)); };
  console.warn = (...a) => { orig.warn(...a); appendLog(name, 'WARN', fmt(a)); };
  console.error = (...a) => { orig.error(...a); appendLog(name, 'ERROR', fmt(a)); };
  process.on('uncaughtException', (err) => { appendLog(name, 'FATAL', `uncaughtException: ${err.stack ?? err}`); orig.error(err); process.exit(1); });
  process.on('unhandledRejection', (err) => { appendLog(name, 'ERROR', `unhandledRejection: ${err?.stack ?? err}`); orig.error(err); });
  return orig;
}

/** 파일 끝에서 n줄 */
export function tailLines(file, n = 50) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-n);
  } catch { return []; }
}
