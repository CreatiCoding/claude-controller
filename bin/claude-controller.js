#!/usr/bin/env node
// CLI 진입점. `npx @creaticoding/claude-controller <명령>` 또는 리포에서 `node bin/claude-controller.js <명령>`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [cmd = 'help', ...args] = process.argv.slice(2);

const HELP = `claude-controller — 폰으로 Claude Code 허가에 응답하는 데몬

사용법: claude-controller <명령>

  doctor           새 환경에서 동작할지 진단 (node·claude CLI·hook 등록·데몬·hook 왕복·폰 연결 경로)
                   --json 으로 기계가 읽을 결과 출력. 실패가 있으면 종료 코드 1
  start            데몬 실행 (포트 9200, config.json으로 변경)
  install-hooks    ~/.claude/settings.json 에 hook 등록 (+ Karabiner 규칙 복사)
                   npx/yarn dlx처럼 임시 경로에서 실행하면 handler를 ~/.claude-controller/ 에 복사해 등록
  uninstall-hooks  이 도구의 hook만 제거
  shell-init       cl 셸 함수 출력 — ~/.zshrc 에  eval "$(claude-controller shell-init)"
  help             이 도움말

처음 쓸 때: install-hooks → start → 폰 브라우저로 접속 → doctor 로 확인
`;

async function main() {
  switch (cmd) {
    case 'doctor': {
      const { doctorMain } = await import('../src/doctor.js');
      process.exit(await doctorMain(args));
    }
    // falls through (process.exit above)
    case 'start':
      await import('../src/daemon.js');
      return;
    case 'install-hooks': {
      const { installHooks, isEphemeralInstall } = await import('../src/hooks-install.js');
      const copy = args.includes('--copy') ? true : args.includes('--no-copy') ? false : isEphemeralInstall();
      const { handler } = installHooks({ copy });
      copyKarabinerRule();
      const cl = copy ? path.join(path.dirname(handler), 'cl.sh') : path.join(ROOT, 'shell', 'cl.sh');
      console.log(`\n다음 단계:\n  1) 데몬 실행: claude-controller start\n  2) ~/.zshrc 에 추가: source ${cl}\n  3) 폰 브라우저에서 대시보드 열기 (README 참고)\n  4) claude-controller doctor 로 점검`);
      return;
    }
    case 'uninstall-hooks': {
      const { uninstallHooks } = await import('../src/hooks-install.js');
      uninstallHooks();
      return;
    }
    case 'shell-init':
      process.stdout.write(fs.readFileSync(path.join(ROOT, 'shell', 'cl.sh'), 'utf8'));
      return;
    case 'help': case '--help': case '-h':
      process.stdout.write(HELP);
      return;
    default:
      console.error(`알 수 없는 명령: ${cmd}\n`);
      process.stdout.write(HELP);
      process.exit(2);
  }
}

function copyKarabinerRule() {
  if (!fs.existsSync('/Applications/Karabiner-Elements.app')) return;
  const dir = path.join(process.env.HOME ?? '', '.config/karabiner/assets/complex_modifications');
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'karabiner', 'claude-controller.json'), path.join(dir, 'claude-controller.json'));
    console.log(`Karabiner 규칙 복사됨 → ${dir}/claude-controller.json (Complex Modifications → Add rule)`);
  } catch (e) {
    console.warn(`Karabiner 규칙 복사 실패: ${e.message}`);
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
