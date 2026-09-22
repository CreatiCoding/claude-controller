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
| 네트워크 의존 | Wi-Fi 없이 USB 케이블만으로 동작 (아이폰은 개인용 핫스팟이 켜져야 하므로 유심/데이터 요금제 필요, 안드로이드는 adb만 있으면 됨) |

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
5. Claude가 즉시 진행(또는 거부)한다. "다시 묻지 않기"면 그 프로젝트에서 같은 프리픽스의 단순 명령(`git push …`)은 더 묻지 않는다. 복합 명령·래퍼·러너 등 규칙을 못 만드는 형태면 1회 승인으로 처리되고 다음에 다시 묻는다. 이때 폰 상단에 "규칙을 만들 수 없는 명령이라 이번 1회만 승인" 안내 띠가 5초간 뜬다.

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
| F-2 | 대시보드에 프로젝트명(cwd 마지막 세그먼트, cwd 없으면 세션 id 앞 8자), 도구별 질문 문구(Bash "이 명령을 실행할까요?", Edit/Write/NotebookEdit "파일을 수정할까요?", Read "파일을 읽을까요?", WebFetch "이 주소를 가져올까요?", 그 외 "<도구> 사용을 허용할까요?"), 상세(command → file_path → url → permissionType → JSON 순 폴백)를 카드로 표시한다 | 구현 |
| F-3 | **예** → `allow`, **아니오** → `deny`(사유 메시지 포함), **터미널에서 응답** → 무출력(passthrough) | 구현·검증 |
| F-4 | **항상 예** → 해당 프로젝트 `.claude/settings.local.json`의 `permissions.allow`에 규칙을 기록한 뒤 `allow`. 규칙을 못 만들거나 기록에 실패(cwd 없음·삭제됨, 파일 파싱 실패, 읽기 전용·권한 없음 등 쓰기 예외)하면 `once`로 강등하고 로그를 남긴다. 사라진 cwd를 되살리지 않는다. 강등은 폰에 응답을 돌려주기 전에 결정되어 `/api/respond` 응답·데몬 로그·hook 출력이 같은 값을 본다 | 구현·검증(규칙 없음·cwd 없음 경로 테스트, 파싱 실패는 단위 테스트) |
| F-5 | 규칙 생성: Bash는 `Bash(<명령> *)`, 서브명령을 갖는 고정 목록(git/npm/pnpm/yarn/docker/kubectl/cargo/go/brew/make/adb/tmux/gh/pip/pip3/poetry/uv/bun)은 `Bash(<명령> <서브명령> *)`. 단독 호출(`docker`)이나 옵션이 서브명령 앞에 오는 경우(`kubectl -n x exec …`, `git -C /x status`)는 2토큰 규칙을 못 만드는데, 러너 서브명령을 가진 명령(uv/poetry/yarn/npm/pnpm/bun/go/cargo/docker/kubectl)은 1토큰 규칙 `Bash(docker *)`가 러너를 통째로 열므로 규칙 없음, 러너가 없는 명령(git/make/brew/adb/tmux/gh/pip/pip3)은 `Bash(git *)` 1토큰 규칙. 첫 토큰에 `/`가 있으면(`/usr/bin/env …`, `./node_modules/.bin/x`) 래퍼 판정을 할 수 없어 규칙 없음. `command`가 없는 Bash 요청은 규칙 없음(도구명 규칙 `Bash`는 전체 허용이라). 선행 `KEY=val`(`FOO=1 make test`)만 벗기고 중간의 `KEY=val`(`make VERBOSE=1 test`)은 인자로 남긴다(빼면 규칙이 원 명령에 프리픽스 매치되지 않아 "다시 묻지 않기"가 무효가 된다). `\|`, `&`, `;`, `<`, `>`, 백틱, `$`, `(`, `)`, 개행 중 하나라도 포함된 복합 명령과 래퍼 명령(sudo/doas/su/env/time/timeout/nohup/nice/xargs/exec/command/builtin/sh/bash/zsh/eval/source/`.`/watch/chroot, 임의 패키지 실행기 npx/pipx/uvx/bunx — 래퍼 검사가 서브명령 검사보다 먼저다), 그리고 뒤에 오는 프로그램을 통째로 여는 러너 2토큰(uv run, uv tool, poetry run, yarn exec/dlx, npm exec/x, pnpm exec/dlx, bun x, go run, cargo run/r, docker run/exec/container/compose, kubectl exec/run)은 규칙 없음. 러너 판정의 경계: 주 목적이 임의 프로그램 실행인 서브명령만 막는다. 옵션·설정 주입 경유 실행(`git -c alias.x='!cmd'`, `git bisect run`, `tmux run-shell`, `git push --receive-pack=`)은 범위 밖이며 `Bash(git *)`류 규칙으로 열릴 수 있다 — 이는 Claude Code 프리픽스 규칙 체계 자체의 한계다. `bun run`·`npm run`·`yarn run`·`pnpm run`은 `node x.js`처럼 직접 실행기와 같은 급으로 보고 허용(`Bash(node *)`가 허용되는 체계와 일관). pipx/uvx/bunx는 래퍼라 `pipx install` 같은 비실행 서브명령도 once로 강등된다(보수적 선택). WebFetch는 `WebFetch(domain:<host>)`, URL 파싱 실패 시 `WebFetch`. 그 외 도구는 도구명. `tool_name`·`permission_type`이 모두 없으면 규칙 없음(once 강등) | 구현·검증 |
| F-6 | 대기 타임아웃(기본 300초, 실질 상한 3600초 = hook 타임아웃) 초과 시 passthrough | 구현 |
| F-7 | hook 연결이 먼저 끊기면(세션 강제 종료) 유령 요청을 즉시 정리 | 구현 |
| F-8 | 요청이 여러 개면 각각 독립 카드·독립 응답. 카드 순서는 세션(최근 활동 순) → 세션 안에서 오래된 순이므로 폰 최상단 카드는 사실상 가장 최근 요청. 매크로패드 1~3번은 전역에서 가장 오래된 요청에 적용 — 둘이 다를 수 있다 | 구현·검증 |
| F-9 | 이미 처리된 요청에 다시 응답하면 `{ok:false}`로 무해 처리(폰 더블탭 안전) | 구현·검증 |

### 5.2 상태 표시 (P0)

| ID | 요구사항 | 상태 |
| --- | --- | --- |
| F-10 | `SessionStart`(source 기록)/`SessionEnd`(reason 기록) → 세션 카드 생성/종료 표시, 종료 후 `endedSessionTtlSeconds`(기본 300) 뒤 제거. 종료 시 남은 허가 요청은 passthrough로 정리하고 상태는 반드시 `ended`. 종료 직후엔 updatedAt이 갱신돼 TTL 동안 목록 맨 위에 보인다. 종료 뒤 늦게 온 Stop/Notification/중복 SessionEnd는 통째로 무시된다(상태·updatedAt·lastMessage·TTL 모두 불변, 목록 순서도 안 바뀜). 같은 id의 `SessionStart`(resume) 또는 **허가 요청 도착**(SessionStart hook이 유실된 resume 등, 실제로 살아 있다는 증거)만 되살리며 이때 TTL 삭제를 취소하고, 재종료 시 TTL은 재종료 시점부터 다시 센다 | 구현·검증 |
| F-11 | `Stop` → 완료(대기 카드는 유지; 남은 요청이 해소되면 `working`으로 돌아감), `Notification(idle_prompt, agent_needs_input)` → 입력 대기 + 마지막 메시지 1줄. `Notification(permission_prompt)`는 그 세션에 우리 hook이 잡고 있는 요청이 없을 때만(passthrough·타임아웃 뒤 터미널 프롬프트) 입력 대기. 그 외 Notification은 메시지만 갱신 | 구현·검증 |
| F-12 | WebSocket으로 상태 변경 즉시 푸시(한 틱 내 변경은 1회로 병합), 초기 접속 시 스냅샷 전송, 끊기면 1초→2배→최대 15초 백오프 재접속 | 구현·검증(스냅샷·브로드캐스트만 테스트, 병합·백오프는 코드 확인) |
| F-13 | 허가 대기 중 배경 전체 점멸(0.5초 주기, 주황) + 대기 요청 수가 늘어날 때마다 진동(지원 기기) | 구현 |
| F-14 | 화면 꺼짐 방지(Wake Lock: 진입·탭 복귀·첫 터치 시 재획득), iOS PWA 전체화면·safe-area(다이나믹 아일랜드) 대응. 매니페스트의 세로 고정은 안드로이드 Chrome만 적용(iOS Safari는 무시) | 구현 |
| F-15 | 세션 행에 모델(다이얼로 바꾼 경우만), 확장 사고 추정 상태, tmux 여부 중 하나라도 있으면 메타 행 표시 | 구현 |
| F-16 | 미인식 hook 이벤트, `session_id` 없는 페이로드는 데몬 로그에 남긴다(스키마 변경 감지) | 구현·검증(로그 문자열까지 테스트) |

### 5.3 연결과 설치 (P0)

| ID | 요구사항 | 상태 |
| --- | --- | --- |
| F-17 | `host:'auto'`면 `127.0.0.1`에 항상 바인딩하고, `autoBindSubnets`(아이폰 172.20.10.x, 안드로이드 192.168.42.x) 대역의 인터페이스를 10초 주기로 감지해 자동 바인딩/해제. `excludeInterfaces`(기본 `wifi` = macOS Wi-Fi 포트)는 대역이 맞아도 제외. `host`에 IP를 지정해도 `127.0.0.1`은 유지 | 구현 |
| F-18 | 필수 주소(`127.0.0.1` 또는 고정 `host`) 바인딩 실패(포트 충돌)면 데몬을 exit 1로 종료한다. 테더링 주소 실패는 로그만 남기고 10초 주기 감지 때마다 재시도한다(실패가 지속되면 로그도 반복) | 구현 |
| F-19 | 안드로이드는 `adb reverse tcp:<port>`를 30초 주기로 재시도, 상태 변화 시만 로그. adb 미설치면 인터벌 중단 | 구현(미설치 경로만 확인, 실기기 미검증) |
| F-20 | `scripts/install.sh` 한 번으로 의존성 설치, 대시보드 빌드, hook 등록, tmux/adb 존재 점검, Karabiner 설치 시 규칙 파일 복사를 끝낸다 | 구현·검증(실기기 1회) |
| F-21 | hook 등록은 `~/.claude/settings.json`(사용자 스코프)의 기존 hook을 보존하고, 재실행 시 중복 없이 갱신하며, 백업(`settings.json.claude-controller.bak`, 재실행마다 덮어씀)을 남긴다. settings.json 파싱에 실패하면 백업 전에 중단(파일 미변경). node는 `process.execPath` 절대경로로 기록. `config.json`의 `port`가 정수이고 기본값과 다르면 `CLAUDE_CONTROLLER_PORT` env로 전달 | 구현·검증(실기기 1회 설치, 중복 제거·port env는 코드 확인) |
| F-22 | hook 타임아웃: PermissionRequest 3600초, 나머지 10초. hook-handler 자체 fetch 타임아웃은 허가 1시간, 그 외 3초 | 구현 |
| F-23 | `scripts/uninstall-hooks.js`로 이 리포의 hook만 제거(command에 `hook-handler.js` 포함 항목). 백업은 만들지 않는다 | 구현 |
| F-24 | yarn/corepack이 없는 환경(node 25+)에서도 설치가 완주한다(`npx corepack` 폴백) | 구현·검증 |
| F-30 | **CLI 패키징**: `npx @creaticoding/claude-controller <명령>` / `yarn dlx …`로 클론 없이 사용. 명령은 `doctor`·`start`·`install-hooks`·`uninstall-hooks`·`shell-init`·`help`. npm 패키지는 `dist/`를 동봉(`prepack`에서 빌드). npx/dlx 캐시처럼 임시 경로에서 `install-hooks`를 실행하면 handler와 cl.sh를 `~/.claude-controller/`에 복사해 그 경로를 등록한다(캐시가 지워져도 hook이 살아 있게). `--copy`/`--no-copy`로 강제. 설정은 `~/.claude-controller/config.json`(리포 루트가 우선) | 구현·검증(tarball 설치 후 npx로 install-hooks·doctor 실행, 격리 HOME 테스트 7개) |
| F-32 | **한 줄 로컬 설치**(`scripts/install-cli.sh`, publish 불필요): `curl … \| bash`로 리포를 `~/.claude-controller/repo`에 얕은 클론(이미 있으면 `git pull --ff-only`), yarn→corepack→npx corepack 폴백으로 의존성 설치·빌드, `~/.local/bin/claude-controller` 래퍼(`exec node <repo>/bin/claude-controller.js`) 생성, PATH 미포함 시 안내. 클론 안에서 실행하면 그 클론 사용. `--uninstall`로 래퍼·클론 제거. `CC_REPO_DIR`/`CC_BIN_DIR`/`CC_REPO_URL`/`CC_BRANCH`로 위치 변경. node 20.19 미만이면 중단 | 구현·검증(클론 내·파이프(GitHub 클론)·재실행·제거 4경로 실행 확인) |
| F-31 | **doctor**: 새 환경에서 동작할지 진단. Node 버전, claude CLI, dist 존재, config 파싱·`0.0.0.0` 경고, hook 5개 이벤트 등록, hook 명령의 node 절대경로 존재, handler 존재·복사본 최신 여부, hook 포트=데몬 포트, hook 타임아웃≥대기 시간, 데몬 응답·포트 점유 프로세스, **실제 hook-handler로 SessionStart 왕복**(자동 정리), Wi-Fi 인터페이스 식별, 테더링 인터페이스(Wi-Fi에만 있으면 경고), adb 기기, tmux, Karabiner 규칙, rc의 cl.sh source. 실패가 있으면 종료 코드 1, `--json` 출력 | 구현·검증(데몬 유무 양쪽, 포트 불일치·오래된 복사본 감지 테스트) |
| F-25 | `cl` 셸 함수: tmux 밖이면 프로젝트별 tmux 세션(`claude-<폴더명>`, 특수문자는 `_`)을 만들어 claude 실행, 같은 폴더에서 재실행하면 기존 세션에 재접속(이때 전달한 인자는 무시됨), 이미 tmux 안이면 그냥 `claude`. 인자는 tmux 경유 시 공백 기준으로 합쳐진다. tmux 없으면 경고 후 plain claude. 모델은 지정하지 않는다 | 구현 |

### 5.4 다이얼 액션 (P1, 선택)

| ID | 요구사항 | 상태 |
| --- | --- | --- |
| F-26 | `POST /api/action`으로 `thinking_down`/`thinking_up`/`model_cycle`/`escape`를 tmux pane에 주입 | 구현 |
| F-27 | 대상 세션은 `sessionId` 지정(pane 미보유·종료 세션이면 실패) 또는 "종료되지 않은, tmux pane을 아는, 가장 최근 활동 세션". tmux 실행 실패(PATH에 없음, pane 소멸)는 200 `{ok:false, error}` | 구현·검증 |
| F-28 | 모델 순환은 `modelCycle` 목록 기준. 세션 모델을 모르면(hook에 정보 없음) 첫 항목부터 시작. 목록이 비어 있으면 `{ok:false}` | 구현 |
| F-29 | 매크로패드: Karabiner(기본) 또는 Hammerspoon(대체)으로 F19~F24를 `POST /api/key` 1~6에 매핑. 1~3은 허가 응답, 4~6은 다이얼. `escape`는 키 매핑 없음. 실패(409) 시 Hammerspoon은 화면 알림을 띄우고 Karabiner는 무반응 | 구현·검증(키 1) |

## 6. 비기능 요구사항

| ID | 요구사항 | 상태 |
| --- | --- | --- |
| N-1 | **Fail-open**: 데몬 미실행, 타임아웃, 파싱 실패, non-2xx 응답 등 어떤 장애에서도 hook은 무출력 종료(exit 0)하여 Claude Code 기본 동작에 간섭하지 않는다 | 구현·검증 |
| N-2 | **보안**: 승인 API에 인증이 없으므로 루프백과 폰 USB 테더링 대역 외에는 바인딩하지 않는다. Wi-Fi 인터페이스는 대역이 맞아도 제외. `0.0.0.0` 설정 시 경고. **CSRF 방어**: 모든 POST는 `Content-Type: application/json`이어야 하고(아니면 415, preflight 없는 text/plain simple request 차단), **모든 HTTP 요청**(GET `/api/state`·정적 페이지 포함 — DNS 리바인딩된 페이지는 같은 출처라 폴링으로 스냅샷을 읽을 수 있음)과 **WebSocket 업그레이드**는 요청의 `Host`와 (있다면) `Origin`의 host가 모두 **허용 목록**(루프백 별칭 `127.0.0.1`·`localhost`·`[::1]` + 현재 listen 중인 테더링 주소 + 고정 `host`; `host:'0.0.0.0'`이면 이 머신의 모든 IPv4; 각각 `:port` 포함, 80/443이면 포트 생략형도)에 있어야 한다(아니면 403 + 데몬 로그에 사유). 요청의 Host 헤더와 Origin을 서로 비교하는 방식은 DNS 리바인딩(evil.example → 127.0.0.1)으로 둘을 같게 만들 수 있어 쓰지 않는다. `Origin: null`과 파싱 불가 Origin도 403 — 맥 브라우저나 adb reverse된 폰 브라우저에 열린 임의 사이트가 루프백으로 승인 요청을 쏘는 경로를 막는다. 요청 본문 제한(바이트 기준, 청크를 Buffer로 세고 끝에서 한 번에 UTF-8 디코드): API는 1MB, `/hook/event`는 8MB(Write/NotebookEdit의 content 전문 대비), 초과 시 413. 본문이 JSON 객체가 아니면(`null`, 배열, 문자열) 400. 정적 파일은 `dist/` 밖 경로 탈출 차단(구분자 포함 검사) | 구현·검증(CSRF·WS 거부·413·400 테스트; `0.0.0.0` 전체 IPv4와 80/443 포트 생략 분기는 코드 확인) |
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
| `GET /ws` | 데몬 → 폰 | `{type:"state", sessions, now}` 스냅샷. `/ws` 외 경로 업그레이드는 소켓 파기. Host/Origin 허용 목록 검사(POST와 동일, 실패 시 403 후 파기) |
| `GET /api/state` | 폰 → 데몬 | `{sessions, now}` (`type` 없음) |
| 세션 스키마 | — | `id, cwd, status(working\|waiting\|input\|idle\|ended), model, thinking, hasTmux, lastEvent, lastMessage, startedAt, updatedAt, pending[{id, toolName, toolInput, permissionType, createdAt}]` |
| `POST /api/respond` | 폰 → 데몬 | `{id, decision: once\|always\|deny\|passthrough}` → 200 `{ok, decision, rule}`(always가 once로 강등되면 여기서부터 once); decision 값 오류 400 |
| `POST /api/key` | 매크로패드 → 데몬 | `{key: 1~6 정수}`(숫자형만, `"1"`·`true`는 강제 변환 없이 거부) → 200 / 실패(대기 없음, 범위 밖, 비숫자, 비정수) 409 |
| `POST /api/action` | 폰/매크로패드 → 데몬 | `{action, sessionId?}` → 200 `{ok, …}`(tmux 실패 포함) |
| 공통 오류 | — | 403(모든 요청: 허용 목록 밖 Host/Origin, `Origin: null`, 파싱 불가 Origin), 415(POST: Content-Type 아님), 400(JSON 아님 또는 객체 아님), 413(API 1MB·hook 8MB 바이트 초과), 500(그 외 예외) |
| 개발 프록시 | — | vite는 `changeOrigin`으로 Host를, `headers.origin`으로 Origin을 `127.0.0.1:9200`으로 바꿔 보낸다(위 검사를 통과하기 위해) |
| `GET /*` | 폰 | `dist/` 정적 서빙. 빌드가 없으면 `/`에 503 + 안내. 허용 목록 밖 Host면 정적 파일도 403 JSON |
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
- **다이얼 대상 없음**(tmux 밖 세션만 있음): `{ok:false, error}`. 데몬 프로세스의 PATH에 tmux가 있어야 하며, 없으면 `{ok:false, error:"tmux 실행 실패…"}`(launchd 등으로 띄우면 PATH 축소 주의).
- **폰 최상단 카드 ≠ 매크로패드 대상**: 폰은 최근 활동 세션 우선(사실상 최신 요청), 매크로패드 1~3은 전역 최고령 요청. 요청이 여러 세션에 걸쳐 있으면 다를 수 있다.
- **Stop 뒤 남은 요청이 해소되면** `idle → working`으로 돌아간다(다음 Stop까지).
- **`modelCycle`을 빈 배열로 두면** 모델 순환은 `{ok:false}`. 배열은 통째로 교체되므로 최소 한 항목은 남길 것.
- **다른 호스트명으로 대시보드를 열면**(`mymac.local:9200` 등) 허용 목록 밖이라 `GET /` 자체가 403 JSON(`{"error":"허용되지 않은 Host: …"}`)으로 끝나 대시보드 HTML이 내려오지 않는다. 데몬 로그에는 `[http] 403 GET /` 한 줄(요청한 정적 파일마다 한 줄). `host:'0.0.0.0'`은 이 머신의 IPv4를 전부 허용하지만 호스트명은 여전히 불가.
- **POST 실패 시 폰 표시**: `/api/respond` 실패(403/500/네트워크)는 상단 오류 띠로 알리고 카드는 남는다. 다시 누르면 재시도. 더블탭·이미 처리된 요청은 200 `{ok:false}`라 띠 없이 카드만 사라진다.
- **hook 페이로드가 8MB를 넘으면**(초대형 Write content) 413 → hook은 무출력 종료 → 폰에 안 뜨고 터미널 프롬프트로 간다. 데몬 로그에 `[hook] 413 …` 한 줄을 남긴다.
- **스냅샷은 표시용으로 트리밍**: `toolInput`의 문자열은 중첩 객체·배열(MultiEdit `edits[]`, MCP 입력) 안까지 재귀로, `lastMessage`도 같은 방식으로 4000자에서 잘라 `… (+N자)`를 붙인다. 9단계 이상 중첩된 객체는 통째로 `… (중첩 깊이 초과)`로, 배열은 200개까지만 두고 `… (+N개)`를 덧붙인다(원본이 그대로 흘러나가는 경로 없음). 서로게이트 쌍 중간에서는 자르지 않는다. 규칙 생성은 원본을 쓴다.
- **요청 본문은 UTF-8로 디코드**: 청크 경계에서 한글·이모지가 깨지지 않는다.
- **adb도 PATH 의존**: 데몬 PATH에 adb가 없으면 "찾지 못함"으로 판정하고 재시도를 영구 중단한다(tmux는 호출마다 실패). launchd 등 축소 PATH로 띄웠다면 PATH를 넓혀 재시작.
- **종료 세션이 허가 요청으로 되살아날 때** 새 `cwd`·`tmuxPane`이 **있으면** 그 값으로 갱신된다(pane이 바뀐 resume). tmux 밖에서 resume해 `tmuxPane`이 없으면 옛 pane이 남아 `hasTmux`가 참으로 보이고 다이얼은 옛 pane으로 간다(다음 SessionStart hook이 오면 정리됨).
- **config.json의 `port`가 문자열이면** 데몬은 그 포트로 뜨지만 install-hooks는 정수만 인식해 hook을 9200으로 등록한다 → 정수로 적을 것.
- **Wi-Fi 포트명이 "Wi-Fi"/"AirPort"가 아니면** 제외 실패를 경고로 알리므로 `excludeInterfaces`에 인터페이스 이름을 직접 적는다. `host`가 `auto`가 아니면 networksetup을 실행하지 않는다.
- **hook에 박힌 node 절대경로**가 사라지면(nvm 버전 삭제 등) hook은 조용히 실패(fail-open)한다 → `install-hooks.js` 재실행.
- **install-hooks 실행 시 settings.json이 깨져 있으면** 백업 전에 중단하고 아무것도 바꾸지 않는다(install.sh도 그 자리에서 멈춘다).

## 9. 검증 (2026-09-22)

- **자동 테스트** `yarn test` 39개(CLI·doctor 7개 포함): 규칙 생성(서브명령·env 대입·복합 명령·래퍼·WebFetch), 규칙 파일 병합·중복·파싱 실패 보존, 상태 저장소(다중 대기, 종료 시 정리, TTL, 늦은 이벤트 무시·resume 복구, 정렬), 데몬 통합(임의 포트에 데몬 spawn → 실제 hook-handler로 SessionStart/once/always/규칙 없음 강등/cwd 없음 강등과 응답 일치/deny/passthrough/중복 응답/키 1/WebSocket 브로드캐스트/permission_prompt 상태/다이얼 tmux 실패/CSRF 415·403·같은 Origin/400/413/Stop/SessionEnd/미인식 이벤트 로그/늦은 Stop/resume/데몬 없음 fail-open). 2차 감사 반영분(CSRF, 강등 시점, permission_prompt, 늦은 이벤트) 포함 전부 통과.
- **실기기 엔드투엔드 ×2**: 실제 Claude Code 세션(`claude -p`)에서 Bash 허가 요청이 5초 내 데몬에 도착 → API 응답 → 명령 실행·정상 종료. 1회차는 프로젝트 스코프 hook, 2회차는 `install.sh`가 등록한 **사용자 스코프 hook 그대로**, "항상 예"로 `Bash(touch *)` 규칙 기록까지 확인.
- **설치**: node 26(corepack 없음) 환경에서 `install.sh` 4단계 완주.
- **테스트로 잡은 버그**: 종료 시 남은 허가 요청을 정리하면 상태가 `working`으로 되돌아가던 문제(정리 순서) 수정.
- **미검증**(실기기·환경 필요): 아이폰 USB 테더링 인터페이스 실제 감지, Wi-Fi 제외의 실제 동작, tmux 다이얼 주입(성공 경로), 안드로이드 adb reverse(연결 경로), iOS Wake Lock·PWA 동작, WebSocket 백오프 재접속.
- **미검증(Claude Code 매처 동작)**: 선행 env를 벗긴 규칙(`FOO=1 make test` → `Bash(make test *)`)이 실제로 `FOO=1 make test`에 매치되는지는 Claude Code의 permissions 매처가 선행 env 대입을 정규화하는지에 달렸다. 순수 프리픽스 매치라면 이 규칙은 무효(다음에 다시 묻는다)이며, 그 경우 선행 env 명령도 once로 강등하는 편이 일관된다.
- **2~10차 감사 반영분**: `yarn test` 32개 통과(러너 보유 명령의 단독·옵션 선행 규칙 없음, command 없는 Bash 규칙 없음, 옵션 선행 서브명령·경로 붙은 명령 규칙 없음, pipx/uvx/bunx·uv tool·bun x 차단, 트리밍 깊이·배열 초과 표시, GET /api/state Host 검사·바이트 한도(한글 1.2MB 413)·객체 아닌 본문 400·키 타입·래퍼/러너 확장·중첩 트리밍 포함, 멀티바이트 본문·스냅샷 트리밍·비정수 키·hook 413 로그·중간 KEY=val 인자 포함, WebSocket Origin 거부, hook 본문 8MB·초과 passthrough, 소생 시 cwd/pane 갱신 포함). DNS 리바인딩 Host 위조는 `fetch()`가 Host 헤더를 버리므로 `node:http` + `setHost:false`로 실제 헤더를 보내 검증(evil.example 403, LOCALHOST·[::1] 통과, 포트 생략 403). `Origin: null` 거부, 쓰기 예외 강등, 종료 세션 늦은 이벤트 완전 무시, 중복 SessionEnd 불변, 종료 세션 허가 요청 소생, resume 후 재종료 TTL 포함. `yarn build` 성공 확인(2026-09-22).

## 10. 리스크

- **hook 스키마 변동**: Claude Code 버전에 따라 `PermissionRequest` 입출력 형식이 바뀔 수 있다. 바뀌면 hook은 무출력으로 실패하므로 Claude Code는 안전하지만 기능은 죽는다. 데몬 로그의 `[hook] 미인식 이벤트` / `session_id 없는 페이로드`로 감지한다.
- **확장 사고 UI 변동**: 현재 `Meta+T` 토글 전제. 키 이름은 `thinkingToggleKey`로 바꿀 수 있지만, 단계형으로 바뀌면 좌/우 동일 처리 로직(`daemon.js dialAction`)을 고쳐야 한다.
- **모델 정보 부재**: hook 페이로드에 모델이 없어 다이얼로 바꾼 경우에만 표시. 순환 시작점도 실제 모델과 무관하게 목록 첫 항목.
- **Wi-Fi 제외 의존**: `networksetup`이 없는 환경(비-macOS)에서는 Wi-Fi 제외가 동작하지 않고 경고만 남는다. 이 프로젝트는 macOS 전용이다.
- **uninstall 판정 폭**: `hook-handler.js` 문자열 포함 여부로 판정하므로, 다른 도구가 같은 이름의 스크립트를 hook으로 쓰면 함께 제거될 수 있다. uninstall은 백업을 만들지 않는다.
- **CSRF 방어의 한계**: Host/Origin 허용 목록은 브라우저 경유 공격(cross-site, DNS 리바인딩)을 막는 장치다. 같은 맥에서 도는 임의의 로컬 프로세스는 Host를 마음대로 넣을 수 있으므로 여전히 승인 API를 호출할 수 있다(로컬 프로세스 신뢰는 전제).
- **node 절대경로 의존**: hook 명령에 설치 시점의 node 경로가 박힌다. 그 node가 사라지면 기능이 조용히 죽는다(fail-open). 재설치로 복구.

## 11. 향후 후보 (미확정)

- 대시보드에서 세션 선택 후 다이얼 액션 대상 지정 UI
- `updatedInput`을 이용한 "수정해서 허용"
- 허가 요청 이력(최근 N건) 표시
- 허가 요청이 오래 대기하면 폰 푸시 알림 대체 수단
- SessionStart 페이로드에 모델이 실리면 초기 모델 표시
