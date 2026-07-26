# claude-controller

맥북에서 다른 작업 중에도, **폰 화면**으로 Claude Code 세션 상태를 실시간으로 보고,
터치로 허가 응답(예 / 항상 예 / 아니오)을 보내는 시스템.

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

## 준비하기 (처음 한 번만, 5분)

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

(yarn 설치 + 대시보드 빌드 + Claude Code hook 등록까지 알아서 해준다)

**3. `~/.zshrc`에 한 줄 추가** (터미널에서 `cl` 명령을 쓰기 위해)

```bash
source /경로/claude-controller/shell/cl.sh
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
yarn start    # ① 데몬 켜기 (claude-controller 폴더에서)
cl            # ② 작업할 프로젝트 폴더에서 Claude Code 실행
```

③ 폰 브라우저에서 대시보드 열고 거치대에 두기

- **아이폰**: 케이블 꽂으면 데몬이 자동 감지 → 로그에 뜨는 주소(`http://172.20.10.x:9200`)를
  사파리에서 열기. 처음 한 번 공유 → **홈 화면에 추가** 해두면 다음부턴 아이콘 탭 한 번
- **안드로이드**: 크롬에서 `http://localhost:9200` (adb reverse 자동)

이후엔 자동이다:

- Claude가 허가를 물으면 → **폰 화면이 주황색으로 깜빡깜빡** + 진동
- 폰 화면에서 **예 / 예, 다시 묻지 않기 / 아니오** 터치
- 폰을 안 보고 있어도 5분 안에 응답 없으면 터미널에 평소처럼 프롬프트가 뜬다

> tmux는 다이얼(생각 토글·모델 전환) 기능에만 필요하다. 그냥 `claude`로(또는 VSCode
> 터미널에서) 실행해도 허가 응답·상태 표시는 전부 동작한다. `cl`은 tmux를 알아서
> 씌워주는 명령(같은 폴더에서 다시 실행하면 기존 세션에 재접속, `cl --resume`처럼 인자도 전달됨).

## 개발

대시보드는 React + Vite (`web/`), 패키지 매니저는 yarn berry.

```bash
yarn dev      # 개발 서버(5173) — /api, /ws 는 로컬 데몬(9200)으로 프록시
yarn build    # dist/ 생성 — 데몬이 이걸 서빙한다 (UI 수정 후 재빌드 필요)
```

## 동작 원리

### 허가 응답 (응답 대기형 hook)

1. Claude Code가 허가가 필요한 도구를 실행하려 하면 **`PermissionRequest` hook**이 발동
   → `bin/hook-handler.js`가 stdin JSON을 데몬에 전달하고 응답을 기다린다.
2. 데몬이 WebSocket으로 폰에 요청 전문(도구명 + 명령)을 송출, 화면 테두리 점멸 + 진동.
3. 버튼/터치 응답:
   - **예** → hook이 `{"decision":{"behavior":"allow"}}` 출력
   - **항상 예** → 데몬이 해당 프로젝트 `.claude/settings.local.json`의 `permissions.allow`에
     규칙 추가(예: `Bash(git push *)`, `WebFetch(domain:github.com)`) 후 allow
   - **아니오** → `{"behavior":"deny"}`
4. **타임아웃(기본 300초) 또는 데몬 미실행 시** hook은 아무 출력 없이 종료
   → 터미널의 기본 허가 프롬프트로 자연스럽게 넘어간다. 즉 이 시스템이 죽어도 Claude Code는 평소대로 동작.

### 상태 표시

- `SessionStart`/`SessionEnd` → 세션 카드 생성/제거
- `Stop` → "완료" 표시 (cc-streamdeck 패턴)
- `Notification`(idle_prompt 등) → "입력 대기" 표시 + 마지막 메시지를 목록에 1줄 표시
- hook 실행 환경의 `$TMUX_PANE`을 함께 보내 세션↔tmux pane 매핑

## 설정 (선택)

리포 루트에 `config.json` 생성 시 기본값을 덮어쓴다:

```json
{
  "port": 9200,
  "permissionWaitSeconds": 300,
  "modelCycle": ["sonnet", "opus"],
  "thinkingToggleKey": "M-t",
  "adb": { "enabled": true, "intervalSeconds": 30 }
}
```

## API (참고)

| 메서드/경로         | 설명                                                                    |
| ------------------- | ----------------------------------------------------------------------- |
| `POST /hook/event`  | hook-handler 전용. PermissionRequest는 응답이 올 때까지 대기            |
| `POST /api/respond` | `{id, decision: once\|always\|deny\|passthrough}`                       |
| `POST /api/key`     | `{key: 1~6}` — 매크로패드(Karabiner)가 호출                             |
| `POST /api/action`  | `{action: thinking_down\|thinking_up\|model_cycle\|escape, sessionId?}` |
| `GET /api/state`    | 현재 스냅샷(JSON)                                                       |
| `GET /ws`           | WebSocket — `{type:"state", sessions:[...]}` 브로드캐스트               |

데몬은 `127.0.0.1`과 폰 USB 테더링 인터페이스에만 바인딩된다. 폰 연결은
USB 터널(테더링/adb reverse)이라 Wi-Fi 등 외부 네트워크를 전혀 타지 않는다.

## 문제 해결

- **아이폰에서 접속 안 됨** — 개인용 핫스팟이 켜져 있는지, 데몬 로그에
  `폰 테더링 감지 — http://172.20.10.x:9200` 가 떴는지 확인(감지는 10초 주기).
  Wake Lock은 iOS 16.4+ 사파리 필요. 아이폰은 진동 알림이 안 되므로 화면 점멸이 대신한다.
- **안드로이드에서 접속 안 됨** — `adb devices`로 기기 인식 확인(디버깅 허용 팝업), 케이블/포트 교체.
  데몬 로그에 `[adb] reverse tcp:9200 연결됨`이 떠야 정상.
- **대시보드가 안 뜸(빌드 없음 안내)** — `yarn build` 실행 후 데몬 재시작 없이 새로고침.
- **허가 요청이 폰에 안 뜸** — 데몬을 hook 등록 _후에_ 시작했는지, Claude Code 세션을 hook 등록
  후 새로 시작했는지 확인. `~/.claude/settings.json`에 `PermissionRequest` 항목 존재 확인.
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
