# claude-controller — 프로젝트 컨텍스트

> Claude Code 세션에서 이 리포를 작업할 때 필요한 배경. 사용자용 안내는 README.md,
> 매크로패드는 ADVANCED_MACROPAD.md 참고.

## 프로젝트 한 줄 요약

맥북에서 다른 작업 중에도, 폰 화면으로 Claude Code 세션 상태를 실시간으로 보고,
터치(또는 선택 사항인 매크로패드 물리 버튼)로 허가 응답(예/항상 예/아니오)과
다이얼 명령을 보내는 시스템.

## 아키텍처

```
[매크로패드(선택)] ──USB──▶ [맥북]
     F19~F24                  │
                        데몬 서버 (포트 9200, src/daemon.js)
                        ├ ① Claude Code hook 수신 (PermissionRequest 등)
                        ├ ② Karabiner-Elements: F19~F24 전역 감지 → POST /api/key
                        ├ ③ tmux send-keys: /model, 생각 토글 주입
                        └ ④ WebSocket: 대시보드 상태 송출
                              │
                        USB 케이블 (아이폰: USB 테더링 / 안드로이드: adb reverse)
                              ▼
[폰] 브라우저 → React 대시보드 (PWA 전체화면 + Wake Lock)
```

## 핵심 설계 결정 (이유 포함)

1. **터미널 CLI 세션 대상, hook 기반** — 공식 BLE 브릿지(claude-desktop-buddy)는
   데스크톱 앱 내 세션만 지원. 터미널 세션은 hook이 공식 경로.
2. **폰은 네이티브 앱이 아닌 웹 대시보드** — 데몬이 서빙하는 React SPA(`web/` 소스,
   `dist/` 빌드 산출물). BLE가 불필요하므로 앱 개발 이유 없음.
3. **폰-맥 연결은 USB 직결** — Wi-Fi를 쓸 수 없는 환경(AP 격리망, 유심 없는 공기계 등)에서도
   동작. 안드로이드는 `adb reverse tcp:9200`, 아이폰은 USB 테더링 인터페이스
   (172.20.10.x)를 데몬이 자동 감지해 바인딩. 회사망 등 외부 네트워크에는 바인딩하지 않는다.
4. **매크로패드는 맥북에 연결** (폰 아님). 폰은 순수 디스플레이 + 터치 입력.
5. **"항상 예" 구현** — 데몬이 프로젝트 `.claude/settings.local.json`의
   `permissions.allow`에 규칙 추가 후 allow (규칙 생성은 `src/permissions.js`).
6. **다이얼 기능은 tmux 전제** — 데몬이 `tmux send-keys`로 주입. `shell/cl.sh`의 `cl`
   함수가 tmux를 자동으로 씌운다. tmux 없이도 허가 응답·상태 표시는 전부 동작.
7. **장애 시 무해(fail-open)** — hook이 타임아웃(기본 300초)되거나 데몬이 죽어 있으면
   무출력 종료 → Claude Code의 기본 터미널 프롬프트로 자연스럽게 넘어간다.

## 코드 맵

- `src/daemon.js` — HTTP/WS 서버, hook 이벤트 라우팅, 허가 응답, 다이얼 액션
- `src/state.js` — 세션/허가요청 인메모리 스토어
- `src/permissions.js` — "항상 예" allow 규칙 생성·기록
- `src/tmux.js` / `src/adb.js` — tmux 주입, adb reverse 재시도
- `bin/hook-handler.js` — Claude Code hook이 실행하는 스크립트 (stdin JSON → 데몬)
- `scripts/install-hooks.js` — `~/.claude/settings.json`에 hook 등록/제거
- `web/` — React + Vite 대시보드 (yarn dev / yarn build)
- `karabiner/claude-controller.json` — F19~F24 → `/api/key` 매핑 (매크로패드용)
- `hammerspoon/init.lua` — Karabiner를 못 쓰는 환경용 대체재

## 작업 시 주의

- 대시보드 UI 수정 후 `yarn build` 해야 데몬(`dist/` 서빙)에 반영된다.
- 데몬은 127.0.0.1 + 폰 USB 테더링 대역에만 바인딩할 것 (인증 없는 승인 API이므로
  외부 인터페이스에 열면 안 됨).
- hook 스키마는 Claude Code 버전에 따라 바뀔 수 있다 — 이벤트 추가 시 공식 문서 확인.
