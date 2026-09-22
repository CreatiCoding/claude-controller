// 데몬 설정. 리포 루트의 config.json(선택)으로 덮어쓸 수 있다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const defaults = {
  // 'auto': 127.0.0.1 + 아이폰 USB 테더링 인터페이스(아래 autoBindSubnets)를
  // 자동 감지해 함께 바인딩. 특정 주소만 쓰려면 IP 문자열로 지정.
  host: 'auto',
  port: 9200,

  // host가 'auto'일 때 추가로 바인딩할 IPv4 프리픽스.
  // 172.20.10. = 아이폰 개인용 핫스팟(USB 테더링) 고정 대역.
  // 192.168.42. = 안드로이드 USB 테더링 기본 대역.
  autoBindSubnets: ['172.20.10.', '192.168.42.'],

  // 자동 바인딩에서 제외할 인터페이스 이름. 기본 'wifi'는 macOS의 Wi-Fi 포트를
  // networksetup으로 찾아 제외한다 — 아이폰 핫스팟에 Wi-Fi로 붙으면 USB 테더링과
  // 같은 172.20.10.x 대역이라, 이 제외가 없으면 핫스팟에 합류한 다른 기기도
  // 인증 없는 승인 API에 닿을 수 있다. ['wifi', 'en7']처럼 이름을 더할 수 있다.
  excludeInterfaces: ['wifi'],

  // 허가 요청(PermissionRequest hook)이 폰/매크로패드 응답을 기다리는 시간(초).
  // 초과하면 'passthrough' — hook이 아무 결정도 내리지 않고 터미널의 기본 허가
  // 프롬프트로 넘어간다. 넉넉히 잡되, 터미널 앞에 있을 때를 위해 무한은 피한다.
  permissionWaitSeconds: 300,

  // 노브 누름(KEY6)으로 순환할 모델 목록. /model <이름> 으로 주입된다.
  modelCycle: ['sonnet', 'opus'],

  // 확장 사고 토글 키. 터미널에서 Meta+T는 ESC 프리픽스(M-t)로 전달된다.
  // (Claude Code 기본 키바인딩 chat:thinkingToggle = Meta+T)
  thinkingToggleKey: 'M-t',

  // 세션 종료 후 대시보드에서 카드를 제거하기까지의 유예(초)
  endedSessionTtlSeconds: 300,

  adb: {
    enabled: true,
    // adb reverse tcp:<port> tcp:<port> 재시도 주기(초). 폰을 나중에 꽂아도 붙는다.
    intervalSeconds: 30,
  },
};

function deepMerge(base, over) {
  if (over === null || typeof over !== 'object' || Array.isArray(over)) return over ?? base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = k in base ? deepMerge(base[k], v) : v;
  }
  return out;
}

let config = defaults;
// 리포 루트의 config.json이 우선, 없으면 ~/.claude-controller/config.json (npx/yarn dlx 사용 시 위치)
export const HOME_CONFIG = path.join(os.homedir(), '.claude-controller', 'config.json');
for (const userConfigPath of [path.join(ROOT, 'config.json'), HOME_CONFIG]) {
  if (!fs.existsSync(userConfigPath)) continue;
  try {
    config = deepMerge(defaults, JSON.parse(fs.readFileSync(userConfigPath, 'utf8')));
  } catch (err) {
    console.error(`[config] ${userConfigPath} 파싱 실패, 기본값 사용: ${err.message}`);
  }
  break;
}

// 환경변수 덮어쓰기 (테스트·임시 실행용). hook-handler도 같은 이름을 본다.
if (process.env.CLAUDE_CONTROLLER_PORT) config.port = Number(process.env.CLAUDE_CONTROLLER_PORT);
if (process.env.CLAUDE_CONTROLLER_HOST) config.host = process.env.CLAUDE_CONTROLLER_HOST;

export default config;
