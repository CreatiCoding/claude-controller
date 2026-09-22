// "항상 예" 처리: 해당 프로젝트의 .claude/settings.local.json permissions.allow에
// 규칙을 추가한다. (Local 스코프가 User 스코프보다 우선 — 공식 permissions 문서)
import fs from 'node:fs';
import path from 'node:path';

// Bash 명령에서 규칙 프리픽스로 삼을 토큰 수를 늘려주는 명령들
const SUBCOMMAND_CMDS = new Set([
  'git', 'npm', 'pnpm', 'yarn', 'npx', 'docker', 'kubectl', 'cargo', 'go',
  'brew', 'make', 'adb', 'tmux', 'gh', 'pip', 'pip3', 'poetry', 'uv',
]);

// 뒤에 임의의 명령이 붙는 래퍼 — 프리픽스 규칙을 만들면 사실상 전부 허용이 된다
const WRAPPER_CMDS = new Set(['sudo', 'env', 'time', 'nohup', 'nice', 'xargs', 'exec', 'sh', 'bash', 'zsh', 'eval', 'source', '.']);

/** 허가 요청 페이로드로부터 permissions.allow 규칙 문자열을 만든다. 못 만들면 null. */
export function ruleForRequest({ toolName, toolInput, permissionType }) {
  const tool = toolName || permissionType;
  if (!tool || tool === 'unknown') return null;

  if (tool === 'Bash' && toolInput?.command) {
    const command = String(toolInput.command).trim();
    // 파이프·체인·리다이렉트·서브셸이 섞인 복합 명령은 첫 토큰만으로 의도를 대표할 수 없다
    // (예: `cd x && git push` → `Bash(cd *)`가 되면 cd로 시작하는 모든 명령이 열린다). 1회 승인으로 강등.
    if (/[|&;<>`$()\n]/.test(command)) return null;
    const words = command.split(/\s+/);
    // 선행 env 대입(FOO=1 BAR=2 cmd)만 벗긴다. 중간의 KEY=val(make VERBOSE=1 test)은 인자이므로
    // 남겨야 한다 — 빼면 만들어진 규칙이 원래 명령에 프리픽스 매치되지 않아 "다시 묻지 않기"가 무효가 된다.
    while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift();
    if (words.length === 0) return null;
    // 래퍼 명령(sudo/env/time 등)은 뒤에 오는 실제 명령이 무엇이든 열리므로 규칙을 만들지 않는다
    if (WRAPPER_CMDS.has(words[0])) return null;
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
    try {
      // cwd가 사라졌으면 프로젝트 폴더를 통째로 되살리지 않는다 — 규칙을 기록할 곳이 없는 것으로 본다
      if (!fs.existsSync(cwd)) throw new Error('cwd가 존재하지 않음');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
    } catch (err) {
      // 읽기 전용 볼륨(EROFS)·권한 없음(EACCES) 등 — 호출자가 once로 강등한다
      console.error(`[permissions] ${file} 기록 실패(${err.message}) — 규칙 추가 건너뜀`);
      return false;
    }
    console.log(`[permissions] allow 규칙 추가: ${rule} → ${file}`);
  }
  return true;
}
