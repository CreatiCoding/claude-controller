// 데몬 설정. 리포 루트의 config.json(선택)으로 덮어쓸 수 있다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const defaults = {
  host: '127.0.0.1',
  port: 9200,

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
const userConfigPath = path.join(ROOT, 'config.json');
if (fs.existsSync(userConfigPath)) {
  try {
    config = deepMerge(defaults, JSON.parse(fs.readFileSync(userConfigPath, 'utf8')));
  } catch (err) {
    console.error(`[config] config.json 파싱 실패, 기본값 사용: ${err.message}`);
  }
}

export default config;
