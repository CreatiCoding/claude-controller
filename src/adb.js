// 폰-맥 USB 연결: adb reverse tcp:<port> tcp:<port> 를 주기적으로 시도한다.
// 폰을 나중에 꽂아도, adb 서버가 재시작돼도 자동으로 다시 붙는다.
import { execFile } from 'node:child_process';

export function startAdbReverse(port, intervalSeconds = 30) {
  let lastOk = null; // 상태가 바뀔 때만 로그
  let timer;
  const attempt = () => {
    execFile('adb', ['reverse', `tcp:${port}`, `tcp:${port}`], { timeout: 10_000 }, (err, _out, stderr) => {
      if (err?.code === 'ENOENT') {
        // adb 자체가 없음 = 안드로이드 미사용(아이폰 등). 조용히 종료.
        console.log('[adb] adb 미설치 — 안드로이드 폰을 쓰지 않으면 무시하세요 (아이폰은 USB 테더링 자동 감지)');
        clearInterval(timer);
        return;
      }
      const ok = !err;
      if (ok !== lastOk) {
        if (ok) console.log(`[adb] reverse tcp:${port} 연결됨 — 폰 크롬에서 http://localhost:${port}`);
        else console.log(`[adb] reverse 실패(${(stderr || err.message).trim().split('\n')[0]}) — 폰 연결/USB 디버깅 확인. 재시도 중...`);
        lastOk = ok;
      }
    });
  };
  attempt();
  timer = setInterval(attempt, intervalSeconds * 1000);
  timer.unref();
}
