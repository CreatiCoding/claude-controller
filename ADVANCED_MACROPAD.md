# 매크로패드 가이드 (선택 기능)

폰 터치만으로도 모든 허가 응답이 가능하지만, **물리 버튼**으로 응답하고 싶다면
매크로패드를 붙일 수 있다. 이 문서는 토스 GUARDIANS25 굿즈 매크로패드(EK3D) 기준.

```
[토스 매크로패드(EK3D)] ──USB──▶ [맥북]
        F19~F24                     │
                              Karabiner-Elements: 키 전역 감지
                                    │
                              POST /api/key → 데몬(9200)
                              ├ 1~3: 허가 응답 (예/항상 예/아니오)
                              └ 4~6: tmux send-keys (생각 토글, 모델 전환)
```

## 준비

**1. Karabiner-Elements 설치**

```bash
brew install --cask karabiner-elements
```

`./scripts/install.sh`가 Karabiner 규칙 파일을
`~/.config/karabiner/assets/complex_modifications/`에 복사해 준다.

**2. Karabiner에서 규칙 켜기**

Karabiner-Elements 열기 → Complex Modifications → **Add rule** → "claude-controller" **Enable**

**3. 매크로패드 키맵 설정** (윈도우 PC에서 제조사 프로그램으로 1회 — 완료)

| 키        | 매크로패드 전송 | 동작                                                                           |
| --------- | --------------- | ------------------------------------------------------------------------------ |
| KEY1      | F19             | **예** (이번 1회 승인)                                                         |
| KEY2      | F20             | **항상 예** (프로젝트 `.claude/settings.local.json`에 allow 규칙 추가 후 승인) |
| KEY3      | F21             | **아니오** (거부)                                                              |
| 노브 좌   | F22             | 생각 토글 (OFF 방향)                                                           |
| 노브 우   | F23             | 생각 토글 (ON 방향)                                                            |
| 노브 누름 | F24             | 모델 순환 (`/model sonnet` ↔ `/model opus`, config로 변경)                     |

키 배치가 다르면 `karabiner/claude-controller.json`에서 `f19`~`f24`와 `key` 번호의
짝만 바꾸고, 파일을 다시 복사(`./scripts/install.sh`) 후 Karabiner 규칙을 다시 켜면 된다.

## 사용법

- Claude가 허가를 물으면 매크로패드 **1(예) / 2(항상 예) / 3(아니오)** 누르면 끝
- 노브: **좌/우 = 생각 토글, 누름 = 모델 전환**
- 허가 요청이 여러 개면 1~3번 키는 **가장 오래 기다린 요청**에 적용된다
- 다이얼(4~6)은 **가장 최근 활동한 tmux 세션**에 적용된다

## 다이얼 명령 동작 원리

- 생각 토글: 현재 Claude Code의 확장 사고 단축키 `Meta+T`(터미널에선 ESC 프리픽스)를
  `tmux send-keys M-t`로 주입. **현재 버전은 단계가 아닌 ON/OFF 토글**이라 좌/우 모두 토글이며,
  대시보드에는 방향 기준 추정 상태(ON/OFF)를 표시한다.
- 모델 전환: `tmux send-keys`로 `/model <이름>` 입력 + Enter. 순환 목록은 config의 `modelCycle`.
- 다이얼 기능은 Claude Code가 tmux 안에서 실행 중일 때만 동작한다(`cl`로 실행하면 자동 충족).
  매크로패드 없이 `POST /api/action`으로도 호출할 수 있다.

## 문제 해결

- **매크로패드 반응 없음** — Karabiner-Elements에서 규칙이 활성화됐는지, 입력 모니터링 권한이
  허용됐는지 확인. Karabiner EventViewer로 매크로패드가 실제로 f19~f24를 보내는지 확인.
- **다이얼이 안 먹음** — Claude Code가 tmux 안에서 실행 중인지 확인(hook이 `$TMUX_PANE`을 보내야 함).
  `cl`로 실행했으면 자동으로 충족된다. 다이얼만 tmux가 필요하고 나머지 기능은 tmux 없이 동작한다.
- **Karabiner를 설치할 수 없는 환경(플랜 B)** — 폰 대시보드 터치 응답은 Karabiner 없이도
  동작한다. Hammerspoon을 쓸 수 있다면 `hammerspoon/init.lua`가 동일 기능의 대체재.
  물리 버튼이 꼭 필요하면 데몬에 IOHIDManager 기반 키 감지(네이티브 헬퍼)를 추가하는
  방안도 있다. 필요 시 이슈로 진행.

## 참고 (검증된 사실)

- EK3D는 제조사 윈도우 프로그램(MINI_KEYBOARD.exe)으로 F19~F24 매핑이 가능하며,
  설정은 기기에 저장되어 맥에서도 유지된다 (실기기 확인).
- 생각 토글 단축키는 `Meta+T`(`chat:thinkingToggle`) — tmux로는 `M-t`를 주입한다.
  Claude Code 버전에 따라 바뀔 수 있으니 안 먹으면 현재 버전에서 확인할 것.
- 관리형(MDM) 맥에서 Karabiner-Elements 설치가 막혀 있다면 위 플랜 B 참고.
