// tmux send-keys 주입. Claude Code를 tmux 안에서 실행하는 것이 전제.
// hook-handler가 $TMUX_PANE을 함께 보내므로 세션별 pane을 안다.
import { execFile } from 'node:child_process';

function tmux(args) {
  return new Promise((resolve, reject) => {
    execFile('tmux', args, { timeout: 5000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr?.trim() || err.message));
      else resolve(stdout);
    });
  });
}

/** 키 이름(M-t, Escape, Enter 등)을 그대로 보낸다 */
export async function sendKeys(pane, ...keys) {
  await tmux(['send-keys', '-t', pane, ...keys]);
}

/** 텍스트를 literal로 입력하고 Enter */
export async function typeLine(pane, text) {
  await tmux(['send-keys', '-t', pane, '-l', text]);
  await tmux(['send-keys', '-t', pane, 'Enter']);
}
