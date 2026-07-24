# claude-controller

맥북에서 다른 작업 중에도, **안드로이드 폰 화면**으로 Claude Code 세션 상태를 실시간으로 보고,
**매크로패드 물리 버튼**으로 허가 응답(예 / 항상 예 / 아니오)과 다이얼 명령(생각 토글, 모델 전환)을 보내는 시스템.

```
[토스 매크로패드(EK3D)] ──USB──▶ [맥북]
  Ctrl+Alt+Shift+Cmd+1~6            │
                              데몬 서버 (포트 9200)
                              ├ ① Claude Code hook 수신 (PermissionRequest 등)
                              ├ ② Karabiner-Elements: 조합키 전역 감지 → 데몬에 전달
                              ├ ③ tmux send-keys: /model, 생각 토글 주입
                              └ ④ WebSocket: 대시보드 상태 송출
                                    │
                              USB 케이블 (adb reverse tcp:9200 tcp:9200)
                                    ▼
[안드로이드 폰] 크롬 → http://localhost:9200 (PWA 전체화면 + Wake Lock)
```

## 요구사항 (맥)

- Node.js 18+
- tmux — **다이얼 기능(생각 토글, 모델 전환)에만 필요.** 허가 응답과 상태 표시는 hook 기반이라
  어떤 터미널(VSCode 통합 터미널 포함)에서 실행해도 동작한다. 다이얼까지 쓰려면 Claude Code를
  tmux 안에서 실행 — 아래 `cld` 함수가 이를 자동화한다. VSCode 통합 터미널 안에서 tmux를 켜는 것도 가능.
- adb (`brew install android-platform-tools`) — 폰 USB 연결용
- Karabiner-Elements (`brew install --cask karabiner-elements`) — 매크로패드 조합키 전역 감지
  (Hammerspoon을 이미 쓰고 있다면 `hammerspoon/init.lua`로 대체 가능 — 데몬 입장에선 `POST /api/key`만 오면 됨)
- 안드로이드 폰: 개발자 옵션에서 **USB 디버깅** 켜기

## 설치

```bash
git clone <이 리포> && cd claude-controller
./scripts/install.sh
```

스크립트가 하는 일:

1. `npm install`
2. `~/.claude/settings.json`에 hook 등록 (`npm run install-hooks`)
   — 기존 설정은 백업(`settings.json.claude-controller.bak`) 후 병합. 제거는 `npm run uninstall-hooks`
3. tmux / adb / Karabiner-Elements 설치 여부 점검 +
   Karabiner 규칙 파일을 `~/.config/karabiner/assets/complex_modifications/`에 복사

그다음 수동 1회 작업:

- Karabiner-Elements → **Complex Modifications → Add rule** → "claude-controller" 규칙 활성화
- 폰을 USB로 연결하고 디버깅 허용 팝업 승인

## 실행

```bash
npm start          # 데몬 시작 — adb reverse는 30초마다 자동 재시도
```

- 폰 크롬에서 `http://localhost:9200` → 메뉴 → **홈 화면에 추가** → 전체화면 PWA
- 화면 꺼짐 방지(Wake Lock)는 대시보드가 자동 요청 (한 번 터치하면 확실히 켜짐)
- Claude Code 실행은 `cld` (아래) 또는 평소처럼 `claude`

### `cld` — tmux 자동 실행 함수

매번 `tmux` → `claude` 두 단계를 거치기 귀찮으니, `~/.zshrc`에 한 줄 추가:

```bash
source /path/to/claude-controller/shell/cld.sh
```

프로젝트 폴더에서 `cld`를 실행하면:

- tmux 밖이면 프로젝트별 세션(`claude-<폴더명>`)을 만들어 그 안에서 claude 실행.
  같은 폴더에서 다시 실행하면 기존 세션에 재접속, claude 종료 시 세션도 닫힘.
- 이미 tmux 안이면(VSCode 터미널에서 tmux를 켠 경우 등) 그냥 claude 실행.
- 인자는 그대로 전달: `cld --resume`
- tmux가 없으면 경고 후 tmux 없이 claude 실행 (허가 응답·상태 표시는 그래도 전부 동작)

## 매크로패드 키맵 (EK3D, 제조사 프로그램으로 1회 설정)

| 키 | 매크로패드 전송 | 동작 |
|----|----|----|
| KEY1 | Ctrl+Alt+Shift+Win+1 | **예** (이번 1회 승인) |
| KEY2 | Ctrl+Alt+Shift+Win+2 | **항상 예** (프로젝트 `.claude/settings.local.json`에 allow 규칙 추가 후 승인) |
| KEY3 | Ctrl+Alt+Shift+Win+3 | **아니오** (거부) |
| 노브 좌 | 동일+4 | 생각 토글 (OFF 방향) |
| 노브 우 | 동일+5 | 생각 토글 (ON 방향) |
| 노브 누름 | 동일+6 | 모델 순환 (`/model sonnet` ↔ `/model opus`, config로 변경) |

- 허가 요청이 여러 개면 1~3번 키는 **가장 오래 기다린 요청**에 적용된다.
- 다이얼(4~6)은 **가장 최근 활동한 tmux 세션**에 적용된다.
- 매크로패드 없이도 폰 터치로 허가 응답 가능(백업 경로). 다이얼 기능(생각/모델)은
  매크로패드 전용이며 `POST /api/action`으로도 호출할 수 있다.

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
- `Notification`(idle_prompt 등) → "입력 대기" 표시
- hook 실행 환경의 `$TMUX_PANE`을 함께 보내 세션↔tmux pane 매핑

### 다이얼 명령

- 생각 토글: 현재 Claude Code의 확장 사고 단축키 `Meta+T`(터미널에선 ESC 프리픽스)를
  `tmux send-keys M-t`로 주입. **현재 버전은 단계가 아닌 ON/OFF 토글**이라 좌/우 모두 토글이며,
  대시보드에는 방향 기준 추정 상태(ON/OFF)를 표시한다.
- 모델 전환: `tmux send-keys`로 `/model <이름>` 입력 + Enter. 순환 목록은 config의 `modelCycle`.

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

| 메서드/경로 | 설명 |
|----|----|
| `POST /hook/event` | hook-handler 전용. PermissionRequest는 응답이 올 때까지 대기 |
| `POST /api/respond` | `{id, decision: once\|always\|deny\|passthrough}` |
| `POST /api/key` | `{key: 1~6}` — Hammerspoon이 호출 |
| `POST /api/action` | `{action: thinking_down\|thinking_up\|model_cycle\|escape, sessionId?}` |
| `GET /api/state` | 현재 스냅샷(JSON) |
| `GET /ws` | WebSocket — `{type:"state", sessions:[...]}` 브로드캐스트 |

데몬은 `127.0.0.1`에만 바인딩된다. 폰은 `adb reverse`가 폰의 localhost:9200을 맥으로 터널링하므로
회사망을 전혀 타지 않는다.

## 문제 해결

- **폰에서 접속 안 됨** — `adb devices`로 기기 인식 확인(디버깅 허용 팝업), 케이블/포트 교체.
  데몬 로그에 `[adb] reverse tcp:9200 연결됨`이 떠야 정상.
- **매크로패드 반응 없음** — Karabiner-Elements에서 규칙이 활성화됐는지, 입력 모니터링 권한이
  허용됐는지 확인. Karabiner EventViewer로 매크로패드가 실제로 hyper+숫자를 보내는지 확인.
  매크로패드 키맵(제조사 윈도우 프로그램) 설정이 완료됐는지 확인.
- **허가 요청이 폰에 안 뜸** — 데몬을 hook 등록 *후에* 시작했는지, Claude Code 세션을 hook 등록
  후 새로 시작했는지 확인. `~/.claude/settings.json`에 `PermissionRequest` 항목 존재 확인.
- **다이얼이 안 먹음** — Claude Code가 tmux 안에서 실행 중인지 확인(hook이 `$TMUX_PANE`을 보내야 함).
  `cld`로 실행했으면 자동으로 충족된다. 다이얼만 tmux가 필요하고 나머지 기능은 tmux 없이 동작한다.
- **MDM이 Karabiner를 차단(플랜 B)** — 폰 대시보드 터치 응답은 Karabiner 없이도 동작한다.
  Hammerspoon이 허용된다면 `hammerspoon/init.lua`가 동일 기능의 대체재.
  물리 버튼이 꼭 필요하면 데몬에 IOHIDManager 기반 키 감지(네이티브 헬퍼)를 추가하는 방안
  (CLAUDE.md의 플랜 B). 필요 시 이슈로 진행.

## 리스크 체크 결과 (CLAUDE.md 항목)

- [x] hook 스키마 — 현재 Claude Code에 `PermissionRequest` hook 이벤트가 존재함을 공식 문서에서 확인.
      stdout `hookSpecificOutput.decision.behavior: allow|deny`, 무출력 시 기본 프롬프트로 진행.
      hook 타임아웃은 비차단(초과 시 실행 계속)이라 응답 대기형 설계에 안전.
- [x] "항상 예" 위치 — 프로젝트 `.claude/settings.local.json`의 `permissions.allow`
      (Local 스코프가 User보다 우선, gitignore 대상이라 팀에 영향 없음).
- [x] 생각 토글 단축키 — `Meta+T` (`chat:thinkingToggle`). tmux로는 `M-t` 주입.
- [ ] 회사 MDM의 Karabiner-Elements 허용 여부 — 실제 맥에서 확인 필요 (대체재/플랜 B 문서화됨).
- [ ] 매크로패드 키맵 설정 완료 여부 — 개인 윈도우 PC에서 1회 설정 필요.
