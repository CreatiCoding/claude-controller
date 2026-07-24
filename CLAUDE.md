# Claude 전용 피지컬 컨트롤러 — 프로젝트 컨텍스트 (인수인계 문서)

> claude.ai 대화에서 설계를 확정하고 Claude Code로 이관한 프로젝트.
> 아래 결정사항은 전부 검증 완료. 재검토 없이 구현 단계부터 시작할 것.

## 프로젝트 한 줄 요약

맥북에서 다른 작업 중에도, 안드로이드 폰 화면으로 Claude Code 세션 상태를 실시간으로 보고,
매크로패드 물리 버튼으로 허가 응답(예/항상 예/아니오)과 다이얼 명령을 보내는 시스템.

## 확정 아키텍처

```
[토스 매크로패드(EK3D)] ──USB──▶ [맥북]
  Ctrl+Alt+Shift+Cmd+1~6            │
                              데몬 서버 (포트 9200)
                              ├ ① Claude Code hook 수신 (PermissionRequest 등)
                              ├ ② Hammerspoon: 조합키 전역 감지 → 데몬에 전달
                              ├ ③ tmux send-keys: /model, 생각 토글 등 주입
                              └ ④ WebSocket: 대시보드 상태 송출
                                    │
                              USB 케이블 (adb reverse tcp:9200 tcp:9200)
                                    ▼
[안드로이드 폰] 크롬 → http://localhost:9200 (PWA 전체화면 + Wake Lock)
```

## 확정 결정사항 (변경 금지, 이유 포함)

1. **터미널 CLI 세션 대상, hook 기반** — 공식 BLE 브릿지(claude-desktop-buddy)는 데스크톱 앱 내 세션만 지원함을 확인. 터미널 세션은 hook이 공식 경로. 참고 구현: `SnowWarri0r/cc-buddy-bridge` (스마트 매처, JSONL tailer 포함), `anthropics/claude-desktop-buddy`의 REFERENCE.md.
2. **폰은 네이티브 앱이 아닌 웹 대시보드** — 데몬이 서빙하는 HTML 1장. BLE 불필요해졌으므로 앱 개발 이유 소멸.
3. **폰-맥 연결은 USB + adb reverse** — 회사망 AP 격리/정책 회피. Wi-Fi/핫스팟 불필요. 폰에서 USB 디버깅 켜야 함. 데몬 시작 스크립트에 `adb reverse tcp:9200 tcp:9200` 자동 실행 포함할 것.
4. **매크로패드는 맥북에 연결** (폰 아님). 폰은 순수 디스플레이.
5. **매크로패드 키맵** — 토스 GUARDIANS25 굿즈(EK3D, VID 0x514c / PID 0x8851). ch57x-keyboard-tool 미지원 변종으로 확인됨(unsupported device). 제조사 윈도우 프로그램(MINI_KEYBOARD.exe)으로 설정하며, 바이너리 분석으로 F13~F24 미지원 / 조합키(Ctrl+Alt+Shift+Win+) 지원 확인. 설정은 기기에 저장되어 맥에서 유지됨(공식 가이드 명시).
   - KEY1 = Ctrl+Alt+Shift+Win+1 → "예" (1회 승인)
   - KEY2 = Ctrl+Alt+Shift+Win+2 → "항상 예"
   - KEY3 = Ctrl+Alt+Shift+Win+3 → "아니오"
   - 노브 좌/우/누름 = 동일 조합+4/5/6 → 생각 수준↓/↑, 모델 전환
   - 맥에서는 cmd+ctrl+alt+shift+숫자(하이퍼키)로 수신. Hammerspoon hotkey 바인딩.
6. **"항상 예" 구현** — Buddy 프로토콜에는 once/deny만 존재(펌웨어·문서 교차 확인). hook 방식에서는 데몬이 설정에 allow 규칙을 추가하거나 hook 응답에서 허용 처리. cc-buddy-bridge의 매처 로직(자동 허용/항상 질문 목록, TOML 설정) 참고.
7. **다이얼 기능** — Claude Code를 tmux 안에서 실행하는 것이 전제. 데몬이 `tmux send-keys`로 주입. `/model`은 로컬 CLI 세션 중 사용 가능. 확장 사고 토글 단축키 존재(버전에 따라 Tab 또는 Alt+T — 구현 시 현재 버전에서 확인 필요).
8. **3D 프린팅 없음** — 기성 거치대 사용.

## 만들 것 (구현 순서)

1. **맥 데몬** (Node 또는 Python, 단일 프로세스)
   - Claude Code hooks 설치/제거 스크립트 (PermissionRequest는 응답 대기형, timeout 넉넉히; Stop hook으로 완료 표시 클리어 — cc-streamdeck 패턴 참고)
   - hook → 데몬 IPC(HTTP 또는 유닉스 소켓, 127.0.0.1 한정)
   - WebSocket으로 상태 브로드캐스트: 세션 목록/상태(working·waiting·idle), 허가 요청 전문(도구명+명령), 최근 메시지, 현재 모델
   - 허가 응답 API: once / deny / always(allow 규칙 추가)
   - tmux 주입 API
   - 시작 시 adb reverse 자동 실행
2. **웹 대시보드** (단일 HTML, 데몬이 서빙)
   - WebSocket 실시간 갱신, 허가 대기 시 화면 강조(테두리 점멸 등)
   - Wake Lock API, 다크 테마, 폰 세로 화면 기준
   - 터치로도 승인/거부 가능 (매크로패드 백업)
3. **Hammerspoon 설정** (`~/.hammerspoon/init.lua`)
   - hyper+1~6 바인딩 → 데몬 API 호출 (hs.http)
4. **문서**: 설치 스크립트 + README

## 사용자 환경/제약

- 회사 맥북 (MDM 가능성 → Hammerspoon/Karabiner 설치 불가 시 데몬이 IOHIDManager로 직접 키 감지하는 플랜 B)
- 사용자는 코딩 가능, 납땜 불가
- 안드로이드 공기계는 유심 없음(핫스팟 불가) → USB 필수인 이유
- 매크로패드 키맵 설정은 개인 윈도우 PC에서 1회 수행 예정 (아직 미완료일 수 있음 — 확인 후 진행)

## 남은 리스크 / 구현 중 확인할 것

- [ ] hook의 PermissionRequest 이벤트 스키마를 현재 Claude Code 버전 문서에서 확인
- [ ] "항상 예"의 allow 규칙 추가 위치(settings.json permissions vs hook 내 처리) 결정
- [ ] 생각 토글 단축키가 현재 버전에서 무엇인지 (? 도움말로 확인)
- [ ] 회사 MDM이 Hammerspoon 허용하는지
- [ ] 매크로패드 키맵 설정 완료 여부

## 시작 명령

이 파일이 있는 폴더에서 `claude` 실행 후:
"CLAUDE.md 읽고 구현 순서 1번(맥 데몬)부터 시작해줘. 언어는 Node로."
