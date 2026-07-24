// "항상 예" 처리: 해당 프로젝트의 .claude/settings.local.json permissions.allow에
// 규칙을 추가한다. (Local 스코프가 User 스코프보다 우선 — 공식 permissions 문서)
import fs from 'node:fs';
import path from 'node:path';

// Bash 명령에서 규칙 프리픽스로 삼을 토큰 수를 늘려주는 명령들
const SUBCOMMAND_CMDS = new Set([
  'git', 'npm', 'pnpm', 'yarn', 'npx', 'docker', 'kubectl', 'cargo', 'go',
  'brew', 'make', 'adb', 'tmux', 'gh', 'pip', 'pip3', 'poetry', 'uv',
]);

/** 허가 요청 페이로드로부터 permissions.allow 규칙 문자열을 만든다. 못 만들면 null. */
export function ruleForRequest({ toolName, toolInput, permissionType }) {
  const tool = toolName || permissionType;
  if (!tool || tool === 'unknown') return null;

  if (tool === 'Bash' && toolInput?.command) {
    const words = String(toolInput.command).trim().split(/\s+/)
      .filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)); // 앞쪽 env 대입 제거
    if (words.length === 0) return null;
    let prefix = words[0];
    if (SUBCOMMAND_CMDS.has(words[0]) && words[1] && !words[1].startsWith('-')) {
      prefix = `${words[0]} ${words[1]}`;
    }
    return `Bash(${prefix} *)`;
  }

  if (tool === 'WebFetch' && toolInput?.url) {
    try {
      return `WebFetch(domain:${new URL(toolInput.url).hostname})`;
    } catch {
      return 'WebFetch';
    }
  }

  // Read/Edit/Write/그 외 도구: 프로젝트 로컬 스코프이므로 도구 단위 허용
  return tool;
}

/** cwd 프로젝트의 .claude/settings.local.json에 allow 규칙을 병합 저장 */
export function addAllowRule(cwd, rule) {
  if (!cwd || !rule) return false;
  const dir = path.join(cwd, '.claude');
  const file = path.join(dir, 'settings.local.json');
  let settings = {};
  try {
    if (fs.existsSync(file)) settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`[permissions] ${file} 파싱 실패(${err.message}) — 규칙 추가 건너뜀`);
    return false;
  }
  settings.permissions ??= {};
  settings.permissions.allow ??= [];
  if (!settings.permissions.allow.includes(rule)) {
    settings.permissions.allow.push(rule);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
    console.log(`[permissions] allow 규칙 추가: ${rule} → ${file}`);
  }
  return true;
}
