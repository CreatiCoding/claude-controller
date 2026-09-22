# claude-controller

맥북에서 다른 작업 중에도, **폰 화면**으로 Claude Code 세션 상태를 실시간으로 보고,
터치로 허가 응답(예 / 항상 예 / 아니오 / 터미널에서 응답)을 보내는 시스템.

> **Disclaimer**: Anthropic과 무관한 비공식 커뮤니티 도구입니다. "Claude"는 Anthropic PBC의
> 상표이며, 이 프로젝트는 Claude Code의 공식 hook 인터페이스를 사용할 뿐 Anthropic의
> 보증·후원을 받지 않습니다.

```
[맥북] 데몬 서버 (포트 9200)
  ├ ① Claude Code hook 수신 (PermissionRequest 등)
  ├ ② WebSocket: 대시보드 상태 송출
  └ ③ tmux send-keys: /model, 생각 토글 주입 (선택)
        │
  USB 케이블 (아이폰: USB 테더링 / 안드로이드: adb reverse)
        ▼
[폰] 브라우저 → 대시보드 (React PWA 전체화면 + Wake Lock)
```

> 물리 버튼(매크로패드)으로도 조작하고 싶다면 → [ADVANCED_MACROPAD.md](ADVANCED_MACROPAD.md)

## 빠른 시작 (한 줄 설치, publish 불필요)

```bash
curl -fsSL https://raw.githubusercontent.com/CreatiCoding/claude-controller/main/scripts/install-cli.sh | bash
```

리포를 `~/.claude-controller/repo`에 클론하고, 의존성 설치·대시보드 빌드 후 `~/.local/bin/claude-controller`
래퍼를 만든다(yarn이 없어도 됨). 이미 클론한 폴더 안에서 `./scripts/install-cli.sh`를 실행하면 그 클론을 그대로 쓴다.
다시 실행하면 `git pull` + 재빌드, `--uninstall`이면 래퍼와 클론 제거. 위치는 `CC_REPO_DIR`·`CC_BIN_DIR`로 바꿀 수 있다.

```bash
claude-controller install-hooks   # hook 등록
claude-controller start           # 데몬 실행
claude-controller doctor          # 새 환경에서 잘 될지 진단
```

| 명령 | 하는 일 |
| --- | --- |
| `claude-controller doctor [--json]` | 새 환경 진단(아래 표). 실패가 있으면 종료 코드 1 |
| `claude-controller start` | 데몬 실행 (`Ctrl-C`로 종료) |
| `claude-controller install-hooks` | `~/.claude/settings.json`에 hook 등록 + Karabiner 규칙 복사. 재실행하면 갱신 |
| `claude-controller uninstall-hooks` | 이 도구의 hook만 제거 |
| `claude-controller logs [-n N] [--follow] [--hook\|--daemon]` | 로그 보기 ([문제 해결](#문제-해결)) |
| `claude-controller shell-init` | `ccode` 함수 출력 — `eval "$(claude-controller shell-init)"` |

설정은 리포 루트 `config.json` 또는 `~/.claude-controller/config.json`. `~/.claude-controller/`에는 클론(`repo/`),
로그(`logs/`), 설정이 모인다. npm에 발행돼 있다면 `npx @creaticoding/claude-controller <명령>` / `yarn dlx …`로도
같은 명령을 쓸 수 있다(이때 handler는 `~/.claude-controller/`에 복사돼 등록된다). 아직 발행 전이다.

### doctor — 환경 진단

새 맥이나 다른 환경에서 "왜 안 되지?"를 한 번에 본다. 실패(❌)가 있으면 종료 코드 1, `--json`으로 기계가 읽는 출력.

| 검사 | 확인하는 것 |
| --- | --- |
| Node.js / Claude Code CLI | 버전·경로 |
| 대시보드 빌드 | `dist/index.html` 존재 |
| config.json | 파싱 가능, `0.0.0.0` 경고 |
| hook 등록 | 5개 이벤트 등록, hook 명령 안의 **node 절대경로가 아직 존재**하는지(brew upgrade로 사라지면 hook이 조용히 죽는다), handler 파일 존재, 복사본이 최신인지, hook 포트 = 데몬 포트, hook 타임아웃 ≥ 대기 시간 |
| 데몬 | `127.0.0.1:포트` 응답 여부, 포트를 다른 프로세스가 점유했는지 |
| hook → 데몬 왕복 | 실제 hook-handler로 SessionStart를 보내 데몬에 도착하는지 (자동으로 정리) |
| 폰 연결 경로 | Wi-Fi 인터페이스 식별(제외 대상), 아이폰 테더링 인터페이스 감지(Wi-Fi에만 있으면 경고), adb 기기 |
| 선택 도구 | tmux, Karabiner 규칙 복사 여부, rc 파일의 `ccode.sh` source |

## 준비하기 (리포로 쓸 때, 처음 한 번만 5분)

**1. 맥에 필요한 것 설치**

```bash
brew install tmux                        # 선택: 다이얼(모델 전환 등) 기능에만 필요
brew install android-platform-tools      # 안드로이드 폰을 쓸 때만
```

**2. 이 리포 설치**

```bash
git clone <이 리포> && cd claude-controller
./scripts/install.sh
```

(yarn 설치 + 대시보드 빌드 + Claude Code hook 등록까지 알아서 해준다. yarn/corepack이 없는 node 25+ 환경이면
스크립트가 `npx corepack`으로 대신 실행하며, 이 경우 데몬은 `node src/daemon.js`로 띄운다.)
클론에서 `claude-controller` 명령까지 쓰고 싶으면 대신 `./scripts/install-cli.sh`를 실행하면 된다 — 이 클론을
그대로 쓰면서 `~/.local/bin/claude-controller` 래퍼만 만든다.

**3. `~/.zshrc`에 한 줄 추가** (터미널에서 `ccode` 명령을 쓰기 위해)

```bash
source /경로/claude-controller/shell/ccode.sh        # 또는 eval "$(claude-controller shell-init)"
```

**4. 폰 준비**

아이폰:

- 설정 → 개인용 핫스팟 → **다른 사람의 연결 허용** 켜기 (유심/데이터 요금제 필요)
- USB 케이블로 맥에 연결 → 맥 네트워크에 "iPhone USB" 인터페이스가 생기면 끝
- ⚠️ 맥의 인터넷이 폰 데이터로 새지 않게: 시스템 설정 → 네트워크 → ⋯ → **서비스 순서**에서
  iPhone USB를 **맨 아래**로

안드로이드:

- 설정 → 개발자 옵션 → **USB 디버깅** 켜기
- USB 케이블로 맥에 연결 → "디버깅 허용" 팝업 **허용** (`brew install android-platform-tools` 필요)

## 사용법 (매일 이것만)

```bash
claude-controller start   # ① 데몬 켜기 (리포에서는 yarn start 또는 node src/daemon.js)
ccode                     # ② 작업할 프로젝트 폴더에서 Claude Code 실행
```

뭔가 이상하면 `claude-controller doctor`, 그래도 모르겠으면 `claude-controller logs` ([문제 해결](#문제-해결)).

③ 폰 브라우저에서 대시보드 열고 거치대에 두기

- **아이폰**: 케이블 꽂으면 데몬이 자동 감지 → 로그에 뜨는 주소(`http://172.20.10.x:9200`)를
  사파리에서 열기. 처음 한 번 공유 → **홈 화면에 추가** 해두면 다음부턴 아이콘 탭 한 번
- **안드로이드**: 크롬에서 `http://localhost:9200` (adb reverse 자동)

이후엔 자동이다:

- Claude가 허가를 물으면 → **폰 화면이 주황색으로 깜빡깜빡** + 진동
- 폰 화면에서 **예 / 예, 다시 묻지 않기 / 아니오 / 터미널에서 응답할게요** 터치
- 폰을 안 보고 있어도 5분 안에 응답 없으면 터미널에 평소처럼 프롬프트가 뜬다

> tmux는 다이얼(생각 토글·모델 전환) 기능에만 필요하다. 그냥 `claude`로(또는 VSCode
> 터미널에서) 실행해도 허가 응답·상태 표시는 전부 동작한다. `ccode`은 tmux를 알아서
> 씌워주는 명령(같은 폴더에서 다시 실행하면 기존 세션에 재접속, `ccode --resume`처럼 인자도 전달됨).

## 개발

대시보드는 React + Vite (`web/`), 패키지 매니저는 yarn berry.

```bash
yarn dev      # 개발 서버(5173) — /api, /ws 는 로컬 데몬(9200)으로 프록시
yarn build    # dist/ 생성 — 데몬이 이걸 서빙한다 (UI 수정 후 재빌드 필요)
yarn test     # node --test 43개: 규칙 생성·상태 저장소 단위, 데몬을 임의 포트로 띄운 hook 왕복, CLI·doctor(격리 HOME), 로그
yarn doctor   # = node bin/claude-controller.js doctor
```

Node 20.19 이상. yarn이 없으면 `npx --yes corepack@latest yarn <명령>`으로 대신 실행할 수 있다.
테스트는 실제 `~/.claude`·`~/.claude-controller`를 건드리지 않는다(HOME·로그 디렉터리 격리, 임의 포트, tmux를 PATH에서 제외).
코드 구조와 설계 결정은 `CLAUDE.md`, 요구사항·엣지케이스·검증 기록은 `PRD.md`에 있다.

## 동작 원리

### 허가 응답 (응답 대기형 hook)

1. Claude Code가 허가가 필요한 도구를 실행하려 하면 **`PermissionRequest` hook**이 발동
   → `bin/hook-handler.js`가 stdin JSON을 데몬에 전달하고 응답을 기다린다.
2. 데몬이 WebSocket으로 폰에 요청 전문(도구명 + 명령)을 송출, 화면 배경 점멸 + 진동.
3. 버튼/터치 응답:
   - **예** → hook이 `{"decision":{"behavior":"allow"}}` 출력
   - **항상 예** → 데몬이 해당 프로젝트 `.claude/settings.local.json`의 `permissions.allow`에
     규칙 추가(예: `Bash(git push *)`, `WebFetch(domain:github.com)`) 후 allow.
     파이프·`&&`·리다이렉트가 섞인 복합 명령, `sudo`/`env`/`timeout` 같은 래퍼 명령,
     `npx …`/`uv run …`/`docker exec …`처럼 뒤에 오는 프로그램을 통째로 여는 러너, 러너를 가진 명령의
     단독 호출·옵션 선행(`docker`, `kubectl -n x …`), 경로가 붙은 명령(`/usr/bin/env …`)은 프리픽스만으로
     의도를 대표할 수 없어 규칙을 만들지 않고 **1회 승인으로 강등**된다(규칙 기록에 실패한 경우도 같다).
     이때 폰 상단에 안내 띠가 뜬다. `git -C x status`·`make -j4 test`처럼 러너가 없는 명령은
     `Bash(git *)` 한 토큰 규칙으로 허용된다.
   - **아니오** → `{"behavior":"deny"}`
4. **타임아웃(기본 300초) 또는 데몬 미실행 시** hook은 아무 출력 없이 종료
   → 터미널의 기본 허가 프롬프트로 자연스럽게 넘어간다. 즉 이 시스템이 죽어도 Claude Code는 평소대로 동작.

### 상태 표시

- `SessionStart`/`SessionEnd` → 세션 카드 생성 / 종료 표시(5분 뒤 제거)
- `Notification(permission_prompt)` → 폰 카드가 떠 있지 않을 때(passthrough·타임아웃 뒤)만 "입력 대기"로 표시
- `Stop` → "완료" 표시 (cc-streamdeck 패턴)
- `Notification`(idle_prompt 등) → "입력 대기" 표시 + 마지막 메시지를 목록에 1줄 표시
- hook 실행 환경의 `$TMUX_PANE`을 함께 보내 세션↔tmux pane 매핑

## 설정 (선택)

리포 루트에 `config.json` 생성 시 기본값을 덮어쓴다(gitignore 대상). 아래가 전체 키와 기본값:

```json
{
  "host": "auto",
  "port": 9200,
  "autoBindSubnets": ["172.20.10.", "192.168.42."],
  "excludeInterfaces": ["wifi"],
  "permissionWaitSeconds": 300,
  "modelCycle": ["sonnet", "opus"],
  "thinkingToggleKey": "M-t",
  "endedSessionTtlSeconds": 300,
  "adb": { "enabled": true, "intervalSeconds": 30 }
}
```

- `host`: `auto`면 127.0.0.1 + 테더링 인터페이스 자동 바인딩. IP를 지정해도 127.0.0.1은 항상 유지된다(hook이 그리로 붙는다).
- `excludeInterfaces`: 테더링 대역이라도 바인딩하지 않을 인터페이스. `wifi`는 맥의 Wi-Fi 포트로 치환된다 — 아이폰 핫스팟에 Wi-Fi로 붙으면 USB와 같은 172.20.10.x 대역이라, 이 제외가 없으면 핫스팟의 다른 기기도 승인 API에 닿는다.
- `permissionWaitSeconds`: 실질 상한 3600초. hook 자체 타임아웃(3600초)이 먼저 끊는다.
- `port`를 바꾸면 `claude-controller install-hooks`(리포에서는 `node scripts/install-hooks.js`)를 다시 실행해야 hook이 새 포트를 본다(`CLAUDE_CONTROLLER_PORT` env로 전달됨). `doctor`가 불일치를 잡는다. Karabiner/Hammerspoon 파일과 vite 프록시의 9200은 직접 바꿔야 한다.
- 배열 값은 병합이 아니라 통째로 교체된다. 환경변수 `CLAUDE_CONTROLLER_PORT`, `CLAUDE_CONTROLLER_HOST`가 있으면 그것이 우선하고, `CLAUDE_CONTROLLER_LOG_DIR`로 로그 위치를 바꿀 수 있다.

## 제거

```bash
claude-controller uninstall-hooks                       # hook 제거 (먼저)
~/.claude-controller/repo/scripts/install-cli.sh --uninstall   # 래퍼·클론 제거 (한 줄 설치로 깔았다면)
node scripts/uninstall-hooks.js                         # 리포에서 직접 쓸 때
```

`uninstall-hooks`는 `~/.claude/settings.json`에서 이 도구의 hook만 제거한다. `~/.claude-controller/config.json`은 직접 지운다.

설치 시 만든 백업은 `~/.claude/settings.json.claude-controller.bak`(재설치마다 덮어씀).

## API (참고)

| 메서드/경로         | 설명                                                                    |
| ------------------- | ----------------------------------------------------------------------- |
| `POST /hook/event`  | hook-handler 전용. PermissionRequest는 응답이 올 때까지 대기            |
| `POST /api/respond` | `{id, decision: once\|always\|deny\|passthrough}`                       |
| `POST /api/key`     | `{key: 1~6}` — 매크로패드(Karabiner)가 호출                             |
| `POST /api/action`  | `{action: thinking_down\|thinking_up\|model_cycle\|escape, sessionId?}` |
| `GET /api/state`    | 현재 스냅샷(JSON)                                                       |
| `GET /ws`           | WebSocket — `{type:"state", sessions:[...]}` 브로드캐스트               |

데몬은 `127.0.0.1`과 폰 USB 테더링 인터페이스에만 바인딩된다. 테더링 감지는 IP 대역
기준이므로 맥의 Wi-Fi 인터페이스는 기본 제외한다(위 `excludeInterfaces`). `/api/respond`와
`/api/action`은 실패해도 200 + `{ok:false, error}`, `/api/key`는 실패 시 409, `/api/state`는
`{sessions, now}`(WS 메시지에만 `type:"state"`가 붙는다).

**모든 요청**(GET 정적 페이지·`/api/state`·POST·WebSocket 업그레이드)은 `Host`와 (있다면) `Origin`이
**데몬이 열어 둔 주소**(`127.0.0.1`, `localhost`, `[::1]`, 테더링 주소, 각각 `:포트` 포함)여야 한다
(아니면 403 + 데몬 로그에 사유). POST는 추가로 `Content-Type: application/json`만 받는다(아니면 415).
인증이 없는 승인 API와 세션 스냅샷을 브라우저에 열린 다른 사이트가 cross-site나 DNS 리바인딩으로
호출·열람하지 못하게 하는 장치다. 그래서 `http://mymac.local:9200`처럼 다른 호스트명으로 대시보드를
열면 페이지 자체가 403 JSON으로 끝난다 — 반드시 위 주소로 접속할 것. curl·hook·Karabiner·Hammerspoon은
`127.0.0.1:포트`로 붙으므로 영향 없다. 본문이 JSON 객체가 아니면 400, API는 1MB·`/hook/event`는
8MB(바이트)를 넘으면 413. 폰 화면은 응답 실패 시 상단에 빨간 띠로 상태 코드를 5초간 보여준다.

## 문제 해결

**먼저 로그부터.** 데몬과 hook은 각각 `~/.claude-controller/logs/daemon.log`, `hook.log`에 타임스탬프·레벨과 함께
기록한다(5MB 넘으면 `.1`로 한 번 굴림). 터미널을 닫아도 남는다.

```bash
claude-controller logs              # 두 로그 끝 50줄
claude-controller logs -n 200 --hook
claude-controller logs --follow     # tail -F
claude-controller doctor            # 최근 300줄의 경고/오류 건수와 마지막 오류를 요약
```

- `daemon.log`: 시작(pid·node·로그 경로), **모든 hook 이벤트 수신**(`[hook] PermissionRequest sid=… tool=…`),
  허가 대기·응답(누가 눌렀는지, 강등 여부, 대기 시간), 타임아웃, 403/413/미인식 이벤트, WS 접속/해제, 바인딩.
- `hook.log`: hook-handler가 **왜 조용히 넘어갔는지** — `데몬 없음(ECONNREFUSED)`, `응답 없음 3s`, `데몬 403/413 …`,
  `stdin JSON 파싱 실패`. 허가 요청의 최종 결정과 소요 시간도 남는다. 로그는 실패·허가 결정만 남기므로 Stop/Notification이
  정상 전달된 경우는 daemon.log 쪽에서 본다.
- "허가 요청이 폰에 안 뜸"은 `hook.log`에 해당 시각 줄이 있는지(hook이 실행됐는지) → `daemon.log`에 `[hook] PermissionRequest`가
  있는지(데몬까지 왔는지) → `[ws] 접속`이 있는지(폰이 붙어 있는지) 순으로 좁힌다.

- **아이폰에서 접속 안 됨** — 개인용 핫스팟이 켜져 있는지, 데몬 로그에
  `폰 테더링 감지 — http://172.20.10.x:9200` 가 떴는지 확인(감지는 10초 주기).
  Wake Lock은 iOS 16.4+ 사파리 필요. 아이폰은 진동 알림이 안 되므로 화면 점멸이 대신한다.
- **안드로이드에서 접속 안 됨** — `adb devices`로 기기 인식 확인(디버깅 허용 팝업), 케이블/포트 교체.
  데몬 로그에 `[adb] reverse tcp:9200 연결됨`이 떠야 정상.
- **대시보드가 안 뜸(빌드 없음 안내)** — `yarn build` 실행 후 데몬 재시작 없이 새로고침.
- **허가 요청이 폰에 안 뜸** — 데몬을 hook 등록 _후에_ 시작했는지, Claude Code 세션을 hook 등록
  후 새로 시작했는지 확인. `~/.claude/settings.json`에 `PermissionRequest` 항목 존재 확인.
  데몬 로그에 `[hook] 미인식 이벤트` 또는 `session_id 없는 페이로드`가 찍히면 Claude Code hook
  스키마가 바뀐 것이다.
- **데몬이 바로 죽음** — 9200 포트를 다른 프로세스가 쓰고 있으면 127.0.0.1 바인딩 실패로 종료한다
  (`lsof -iTCP:9200`). `config.json`의 `port`를 바꾸고 hook을 재등록하면 된다.
- **폰에서 `ccode`로 띄운 세션의 모델을 바꾸고 싶음** — `ccode`은 모델을 지정하지 않는다. 필요하면 `ccode --model opus`처럼 인자로 넘긴다.
- **매크로패드/다이얼 문제** — [ADVANCED_MACROPAD.md](ADVANCED_MACROPAD.md)의 문제 해결 참고.

## 설계 노트

- hook 스키마 — 현재 Claude Code에 `PermissionRequest` hook 이벤트가 존재함을 공식 문서에서 확인.
  stdout `hookSpecificOutput.decision.behavior: allow|deny`, 무출력 시 기본 프롬프트로 진행.
  hook 타임아웃은 비차단(초과 시 실행 계속)이라 응답 대기형 설계에 안전.
- "항상 예" 위치 — 프로젝트 `.claude/settings.local.json`의 `permissions.allow`
  (Local 스코프가 User보다 우선, gitignore 대상이라 팀에 영향 없음).
- 매크로패드 관련 노트는 [ADVANCED_MACROPAD.md](ADVANCED_MACROPAD.md) 참고.

## 라이선스

[MIT](LICENSE) © [CreatiCoding](https://github.com/CreatiCoding)
