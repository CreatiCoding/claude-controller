# PRD — claude-controller

> 제품 요구사항 문서. 사용자 안내는 README.md, 구현 컨텍스트는 CLAUDE.md,
> 매크로패드는 ADVANCED_MACROPAD.md를 본다. 이 문서는 "무엇을, 왜, 어디까지"를 정한다.
> 마지막 갱신: 2026-09-22 (v0.1.0 기준, 자동 테스트 + 실기기 엔드투엔드 검증 완료)

## 1. 배경과 문제

Claude Code를 터미널에서 돌려 두면 허가 프롬프트(예/아니오)가 뜰 때마다 작업이 멈춘다.
다른 창에서 일하거나 자리를 잠깐 비우면 프롬프트가 떠 있는 줄 모르고 시간이 샌다.

- 터미널을 계속 쳐다보고 있어야 한다 → 멀티태스킹 불가
- 세션이 여러 개면 어느 세션이 기다리는지 한눈에 안 보인다
- 공식 원격 제어(claude-desktop-buddy 등)는 데스크톱 앱 내 세션만 지원하고, 터미널 세션은 대상이 아니다

## 2. 목표

폰을 거치대에 두고 **터미널을 안 보고도** Claude Code 세션 상태를 알고, 허가에 응답한다.

성공 기준:

| 지표 | 목표 |
| --- | --- |
| 허가 요청 → 폰 화면 표시 지연 | 1초 이내 (WebSocket 푸시) |
| 폰 터치 → Claude 진행 재개 지연 | 1초 이내 |
| 시스템 장애 시 Claude Code 영향 | 없음 (fail-open, 기본 프롬프트로 복귀) |
| 첫 설치 소요 | 5분 이내, 스크립트 1회 |
| 네트워크 의존 | Wi-Fi 없이 USB 케이블만으로 동작 |

## 3. 비목표

- 폰에서 프롬프트를 타이핑하거나 대화를 이어가는 것 (원격 채팅 클라이언트가 아니다)
- Claude Code 데스크톱 앱 세션 지원 (공식 경로가 따로 있음)
- Wi-Fi/인터넷 경유 원격 접속 (인증 없는 승인 API를 외부에 열지 않는다)
- 네이티브 폰 앱 (웹 대시보드로 충분, BLE 불필요)
- 매크로패드 없이도 완결되어야 하며, 매크로패드는 선택 부가 기능이다
- 다중 사용자, 인증, 승인 이력 영속화

## 4. 사용자와 시나리오

**사용자**: 맥북(macOS)에서 Claude Code CLI를 tmux/터미널로 쓰는 개인 개발자. 폰(아이폰 또는 안드로이드)이 있고 USB 케이블로 맥에 연결할 수 있다. Node 20.19 이상.

**S1. 허가 응답 (핵심)**
1. 사용자가 `cl`(또는 `claude`)로 세션을 켜고 다른 창에서 일한다.
2. Claude가 `git push`를 실행하려 하고 허가가 필요하다.
3. 폰 화면이 주황색으로 점멸하고(안드로이드는 진동) 도구명과 명령이 카드로 뜬다.
4. 사용자가 **예 / 예, 다시 묻지 않기 / 아니오 / 터미널에서 응답할게요** 중 하나를 터치한다.
5. Claude가 즉시 진행(또는 거부)한다. "다시 묻지 않기"면 그 프로젝트에서 같은 프리픽스의 단순 명령(`git push …`)은 더 묻지 않는다. 복합 명령이나 래퍼 명령이면 1회 승인으로 처리되고 다음에 다시 묻는다.

**S2. 상태 모니터링**
- 세션 목록에서 각 세션의 프로젝트명과 상태(작업 중 / 허가 대기 / 입력 대기 / 완료 / 종료됨)를 본다.
- Claude가 턴을 끝내면 "완료", 입력을 기다리면 "입력 대기"와 마지막 메시지 한 줄이 보인다.
- 다이얼로 바꾼 모델·확장 사고 추정 상태, tmux 여부가 세션 행 아래에 보인다.

**S3. 자리 비움 / 장애**
- 폰을 안 봐도 5분 후 터미널의 기본 프롬프트로 넘어간다.
- 데몬이 꺼져 있거나 죽으면 Claude Code는 평소와 완전히 똑같이 동작한다.

**S4. 다이얼 조작 (선택, tmux 필요)**
- 매크로패드 노브 또는 `/api/action`으로 확장 사고 토글, 모델 순환(`/model sonnet` ↔ `/model opus`), Escape를 보낸다.

## 5. 기능 요구사항

상태 표기: **구현·검증** = 자동 테스트(`yarn test`) 또는 실기기로 확인, **구현** = 코드로만 확인.

### 5.1 허가 응답 (P0)

| ID | 요구사항 | 상태 |
| --- | --- | --- |
| F-1 | `PermissionRequest` hook을 받아 데몬에 전달하고, 결정이 올 때까지 hook 프로세스를 대기시킨다 | 구현·검증 |
| F-2 | 대시보드에 도구명, 명령/경로/URL, 프로젝트명(cwd 마지막 세그먼트, cwd 없으면 세션 id 앞 8자)을 카드로 표시한다 | 구현 |
| F-3 | **예** → `allow`, **아니오** → `deny`(사유 메시지 포함), **터미널에서 응답** → 무출력(passthrough) | 구현·검증 |
| F-4 | **항상 예** → 해당 프로젝트 `.claude/settings.local.json`의 `permissions.allow`에 규칙을 기록한 뒤 `allow`. 규칙을 못 만들거나 기록에 실패(cwd 없음, 파일 파싱 실패)하면 `once`로 강등하고 로그를 남긴다 | 구현·검증 |
| F-5 | 규칙 생성: Bash는 `Bash(<명령> *)`, 서브명령을 갖는 고정 목록(git/npm/pnpm/yarn/npx/docker/kubectl/cargo/go/brew/make/adb/tmux/gh/pip/pip3/poetry/uv)은 `Bash(<명령> <서브명령> *)`(두 번째 토큰이 `-`로 시작하면 제외). 앞쪽 `KEY=val`은 무시. 파이프·`&&`·`;`·리다이렉트·서브셸·개행이 포함된 복합 명령과 래퍼 명령(sudo/env/time/nohup/nice/xargs/exec/sh/bash/zsh/eval/source)은 규칙 없음. WebFetch는 `WebFetch(domain:<host>)`, URL 파싱 실패 시 `WebFetch`. 그 외 도구는 도구명 | 구현·검증 |
| F-6 | 대기 타임아웃(기본 300초, 실질 상한 3600초 = hook 타임아웃) 초과 시 passthrough | 구현 |
| F-7 | hook 연결이 먼저 끊기면(세션 강제 종료) 유령 요청을 즉시 정리 | 구현 |
| F-8 | 요청이 여러 개면 각각 독립 카드·독립 응답. 카드 순서는 세션(최근 활동 순) → 세션 안에서 오래된 순. 매크로패드 1~3번만 전역에서 가장 오래된 요청에 적용 | 구현·검증 |
| F-9 | 이미 처리된 요청에 다시 응답하면 `{ok:false}`로 무해 처리(폰 더블탭 안전) | 구현·검증 |

### 5.2 상태 표시 (P0)

| ID | 요구사항 | 상태 |
| --- | --- | --- |
| F-10 | `SessionStart`(source 기록)/`SessionEnd`(reason 기록) → 세션 카드 생성/종료 표시, 종료 후 `endedSessionTtlSeconds`(기본 300) 뒤 제거. 종료 시 남은 허가 요청은 passthrough로 정리하고 상태는 반드시 `ended` | 구현·검증 |
| F-11 | `Stop` → 완료(대기 카드는 유지), `Notification(idle_prompt, agent_needs_input)` → 입력 대기 + 마지막 메시지 1줄. 그 외 Notification은 메시지만 갱신 | 구현·검증 |
| F-12 | WebSocket으로 상태 변경 즉시 푸시(한 틱 내 변경은 1회로 병합), 초기 접속 시 스냅샷 전송, 끊기면 1초→2배→최대 15초 백오프 재접속 | 구현·검증 |
| F-13 | 허가 대기 중 배경 점멸(0.5초 주기, 주황) + 대기 요청 수가 늘어날 때마다 진동(지원 기기) | 구현 |
| F-14 | 화면 꺼짐 방지(Wake Lock: 진입·탭 복귀·첫 터치 시 재획득), iOS PWA 전체화면·세로 고정·safe-area(다이나믹 아일랜드) 대응 | 구현 |
| F-15 | 세션 행에 모델(다이얼로 바꾼 경우만), 확장 사고 추정 상태, tmux 여부 표시 | 구현 |
| F-16 | 미인식 hook 이벤트, `session_id` 없는 페이로드는 데몬 로그에 남긴다(스키마 변경 감지) | 구현·검증 |

### 5.3 연결과 설치 (P0)

| ID | 요구사항 | 상태 |
| --- | --- | --- |
| F-17 | `host:'auto'`면 `127.0.0.1`에 항상 바인딩하고, `autoBindSubnets`(아이폰 172.20.10.x, 안드로이드 192.168.42.x) 대역의 인터페이스를 10초 주기로 감지해 자동 바인딩/해제. `excludeInterfaces`(기본 `wifi` = macOS Wi-Fi 포트)는 대역이 맞아도 제외. `host`에 IP를 지정해도 `127.0.0.1`은 유지 | 구현 |
| F-18 | `127.0.0.1` 바인딩 실패(포트 충돌)면 데몬을 종료한다. 테더링 주소 실패는 로그만 | 구현 |
| F-19 | 안드로이드는 `adb reverse tcp:<port>`를 30초 주기로 재시도, 상태 변화 시만 로그. adb 미설치면 인터벌 중단 | 구현·검증 |
| F-20 | `scripts/install.sh` 한 번으로 의존성 설치, 대시보드 빌드, hook 등록, tmux/adb 존재 점검, Karabiner 설치 시 규칙 파일 복사를 끝낸다 | 구현·검증 |
| F-21 | hook 등록은 `~/.claude/settings.json`(사용자 스코프)의 기존 hook을 보존하고, 재실행 시 중복 없이 갱신하며, 백업(`settings.json.claude-controller.bak`, 재실행마다 덮어씀)을 남긴다. node는 절대경로로 기록. `config.json`의 `port`가 기본값과 다르면 `CLAUDE_CONTROLLER_PORT` env로 전달 | 구현·검증 |
| F-22 | hook 타임아웃: PermissionRequest 3600초, 나머지 10초. hook-handler 자체 fetch 타임아웃은 허가 1시간, 그 외 3초 | 구현 |
| F-23 | `scripts/uninstall-hooks.js`로 이 리포의 hook만 제거(command에 `hook-handler.js` 포함 항목) | 구현 |
| F-24 | yarn/corepack이 없는 환경(node 25+)에서도 설치가 완주한다(`npx corepack` 폴백) | 구현·검증 |
| F-25 | `cl` 셸 함수: 프로젝트별 tmux 세션(`claude-<폴더명>`, 특수문자는 `_`)에서 claude를 실행, 재실행 시 재접속, 인자 전달(tmux 경유 시 공백 기준 합쳐짐), tmux 없으면 경고 후 plain claude. 모델은 지정하지 않는다 | 구현 |

### 5.4 다이얼 액션 (P1, 선택)

| ID | 요구사항 | 상태 |
| --- | --- | --- |
| F-26 | `POST /api/action`으로 `thinking_down`/`thinking_up`/`model_cycle`/`escape`를 tmux pane에 주입 | 구현 |
| F-27 | 대상 세션은 `sessionId` 지정(pane 미보유면 실패) 또는 "종료되지 않은, tmux pane을 아는, 가장 최근 활동 세션" | 구현·검증 |
| F-28 | 모델 순환은 `modelCycle` 목록 기준. 세션 모델을 모르면(hook에 정보 없음) 첫 항목부터 시작 | 구현 |
| F-29 | 매크로패드: Karabiner(기본) 또는 Hammerspoon(대체)으로 F19~F24를 `POST /api/key` 1~6에 매핑. 1~3은 허가 응답, 4~6은 다이얼. `escape`는 키 매핑 없음 | 구현·검증(키 1) |

## 6. 비기능 요구사항

| ID | 요구사항 | 상태 |
| --- | --- | --- |
| N-1 | **Fail-open**: 데몬 미실행, 타임아웃, 파싱 실패, non-2xx 응답 등 어떤 장애에서도 hook은 무출력 종료(exit 0)하여 Claude Code 기본 동작에 간섭하지 않는다 | 구현·검증 |
| N-2 | **보안**: 승인 API에 인증이 없으므로 루프백과 폰 USB 테더링 대역 외에는 바인딩하지 않는다. Wi-Fi 인터페이스는 대역이 맞아도 제외. `0.0.0.0` 설정 시 경고. 요청 본문 1MB 제한. 정적 파일은 `dist/` 밖 경로 탈출 차단 | 구현 |
| N-3 | **네트워크 독립**: 폰-맥 통신은 USB 터널(iOS 테더링 인터페이스 / adb reverse)만 사용. 감지는 IP 프리픽스 기준이라 N-2의 Wi-Fi 제외로 보완한다 | 구현 |
| N-4 | **팀 영향 없음**: "항상 예" 규칙은 gitignore 대상인 `settings.local.json`에만 기록 | 구현·검증 |
| N-5 | **최소 의존성**: 런타임 의존성은 `ws` 하나. tmux·adb·Karabiner/Hammerspoon은 선택. 대시보드는 tmux 없이도 동작(문구도 그렇게 안내) | 구현 |
| N-6 | **상태 휘발**: 세션/요청 상태는 데몬 메모리에만 둔다. 재시작 후에는 다음 hook 이벤트가 `cwd`·`tmuxPane`을 동반하므로 카드가 자연 복구된다 | 구현 |
| N-7 | **재현 가능한 검증**: `yarn test`가 규칙 생성·상태 저장소 단위 테스트와, 데몬을 임의 포트로 띄워 실제 hook-handler를 실행하는 통합 테스트를 돌린다 | 구현·검증 |

## 7. 인터페이스

| 인터페이스 | 방향 | 내용 |
| --- | --- | --- |
| Claude Code hook | Claude → 데몬 | `PermissionRequest`, `Stop`, `Notification`, `SessionStart`, `SessionEnd`. `bin/hook-handler.js`가 stdin JSON + `$TMUX_PANE`을 `POST /hook/event`로 전달. 포트는 `CLAUDE_CONTROLLER_PORT`(기본 9200), 호스트는 127.0.0.1 고정 |
| hook 출력 | 데몬 → Claude | `hookSpecificOutput.decision.behavior: allow \| deny`(deny는 `message` 포함) 또는 무출력 |
| `GET /ws` | 데몬 → 폰 | `{type:"state", sessions, now}` 스냅샷. `/ws` 외 경로 업그레이드는 소켓 파기 |
| `GET /api/state` | 폰 → 데몬 | `{sessions, now}` (`type` 없음) |
| 세션 스키마 | — | `id, cwd, status(working\|waiting\|input\|idle\|ended), model, thinking, hasTmux, lastEvent, lastMessage, startedAt, updatedAt, pending[{id, toolName, toolInput, permissionType, createdAt}]` |
| `POST /api/respond` | 폰 → 데몬 | `{id, decision: once\|always\|deny\|passthrough}` → 200 `{ok, decision, rule}`; decision 값 오류만 400 |
| `POST /api/key` | 매크로패드 → 데몬 | `{key: 1~6}` → 200 / 실패 409 |
| `POST /api/action` | 폰/매크로패드 → 데몬 | `{action, sessionId?}` → 항상 200 `{ok, …}` |
| `GET /*` | 폰 | `dist/` 정적 서빙. 빌드가 없으면 `/`에 503 + 안내 |
| `config.json` | 사용자 → 데몬 | `host, port, autoBindSubnets, excludeInterfaces, permissionWaitSeconds, modelCycle, thinkingToggleKey, endedSessionTtlSeconds, adb.{enabled, intervalSeconds}`. 배열은 통째로 교체. 파싱 실패 시 기본값 + 로그. gitignore 대상 |
| 환경변수 | — | `CLAUDE_CONTROLLER_PORT`, `CLAUDE_CONTROLLER_HOST` (config.json보다 우선, 테스트·임시 실행용) |
| 개발 | — | `yarn dev`(vite 5173, `/api`·`/ws`를 9200으로 프록시), `yarn build`(dist/), `yarn test` |

포트를 9200에서 바꾸면 hook 재등록(`install-hooks.js`)이 필요하고, Karabiner/Hammerspoon 파일과 vite 프록시의 9200은 직접 바꿔야 한다.

## 8. 엣지케이스 (정해진 동작)

- **cwd 없는 세션**: 프로젝트명은 세션 id 앞 8자. "항상 예"는 규칙을 기록할 곳이 없으므로 `once`로 강등.
- **세션당 다중 대기**: 그 세션의 요청이 전부 해소돼야 `waiting → working`. 다른 세션엔 영향 없음.
- **SessionEnd 시 잔여 요청**: 전부 passthrough. 데몬이 모르는 세션의 SessionEnd도 카드를 만든 뒤 종료 상태로 TTL 동안 노출.
- **Stop 시 대기 요청이 남아 있으면** 상태만 `idle`, 카드는 유지.
- **`lastMessage`는 이후 이벤트에서 지워지지 않는다** (마지막으로 받은 메시지를 계속 보여준다).
- **hook 응답이 JSON이 아니거나 non-2xx**: passthrough. 비허가 이벤트는 응답 무시.
- **`/api/key`에 숫자가 아니거나 범위 밖**: 409.
- **테더링 해제**: 사라진 인터페이스의 서버는 close.
- **테더링 대역이 Wi-Fi 인터페이스에만 있음**: 바인딩하지 않고 "USB로 연결하세요" 로그 1회.
- **`permissionWaitSeconds > 3600`**: hook 타임아웃이 먼저 끊어 passthrough. 사실상 3600이 상한.
- **다이얼 대상 없음**(tmux 밖 세션만 있음): `{ok:false, error}`. 데몬 프로세스의 PATH에 tmux가 있어야 한다(launchd 등으로 띄우면 PATH 축소 주의).

## 9. 검증 (2026-09-22)

- **자동 테스트** `yarn test` 21개 통과: 규칙 생성(서브명령·env 대입·복합 명령·래퍼·WebFetch), 규칙 파일 병합·중복·파싱 실패 보존, 상태 저장소(다중 대기, 종료 시 정리, TTL, 정렬), 데몬 통합(임의 포트에 데몬 spawn → 실제 hook-handler로 SessionStart/once/always/강등/deny/passthrough/중복 응답/키 1/WebSocket 브로드캐스트/Stop/SessionEnd/미인식 이벤트/데몬 없음 fail-open).
- **실기기 엔드투엔드 ×2**: 실제 Claude Code 세션(`claude -p`)에서 Bash 허가 요청이 5초 내 데몬에 도착 → API 응답 → 명령 실행·정상 종료. 1회차는 프로젝트 스코프 hook, 2회차는 `install.sh`가 등록한 **사용자 스코프 hook 그대로**, "항상 예"로 `Bash(touch *)` 규칙 기록까지 확인.
- **설치**: node 26(corepack 없음) 환경에서 `install.sh` 4단계 완주.
- **테스트로 잡은 버그**: 종료 시 남은 허가 요청을 정리하면 상태가 `working`으로 되돌아가던 문제(정리 순서) 수정.
- **미검증**(실기기·환경 필요): 아이폰 USB 테더링 인터페이스 실제 감지, Wi-Fi 제외의 실제 동작, tmux 다이얼 주입, 안드로이드 adb reverse, iOS Wake Lock·PWA 동작.

## 10. 리스크

- **hook 스키마 변동**: Claude Code 버전에 따라 `PermissionRequest` 입출력 형식이 바뀔 수 있다. 바뀌면 hook은 무출력으로 실패하므로 Claude Code는 안전하지만 기능은 죽는다. 데몬 로그의 `[hook] 미인식 이벤트` / `session_id 없는 페이로드`로 감지한다.
- **확장 사고 UI 변동**: 현재 `Meta+T` 토글 전제. 키 이름은 `thinkingToggleKey`로 바꿀 수 있지만, 단계형으로 바뀌면 좌/우 동일 처리 로직(`daemon.js dialAction`)을 고쳐야 한다.
- **모델 정보 부재**: hook 페이로드에 모델이 없어 다이얼로 바꾼 경우에만 표시. 순환 시작점도 실제 모델과 무관하게 목록 첫 항목.
- **Wi-Fi 제외 의존**: `networksetup`이 없는 환경(비-macOS)에서는 Wi-Fi 제외가 동작하지 않고 경고만 남는다. 이 프로젝트는 macOS 전용이다.
- **uninstall 판정 폭**: `hook-handler.js` 문자열 포함 여부로 판정하므로, 다른 도구가 같은 이름의 스크립트를 hook으로 쓰면 함께 제거될 수 있다.

## 11. 향후 후보 (미확정)

- 대시보드에서 세션 선택 후 다이얼 액션 대상 지정 UI
- `updatedInput`을 이용한 "수정해서 허용"
- 허가 요청 이력(최근 N건) 표시
- 허가 요청이 오래 대기하면 폰 푸시 알림 대체 수단
- SessionStart 페이로드에 모델이 실리면 초기 모델 표시
