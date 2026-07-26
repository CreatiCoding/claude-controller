#!/usr/bin/env bash
# claude-controller 설치 스크립트 (맥에서 실행)
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== 1/4 의존성 설치 (yarn berry) =="
if ! command -v yarn >/dev/null 2>&1; then
  corepack enable 2>/dev/null || { echo "yarn이 없습니다 — corepack enable 또는 brew install yarn 후 재실행"; exit 1; }
fi
yarn install

echo
echo "== 2/4 대시보드 빌드 (React → dist/) =="
yarn build

echo
echo "== 3/4 Claude Code hook 등록 (~/.claude/settings.json) =="
node scripts/install-hooks.js

echo
echo "== 4/4 환경 점검 =="
for cmd in tmux adb; do
  if command -v "$cmd" >/dev/null 2>&1; then
    echo "  ✅ $cmd 있음"
  else
    echo "  ⚠️  $cmd 없음 — brew install $cmd  (adb는: brew install android-platform-tools)"
  fi
done

# 매크로패드(선택 기능) — Karabiner가 있으면 규칙 파일 복사 (ADVANCED_MACROPAD.md 참고)
if [ -d "/Applications/Karabiner-Elements.app" ]; then
  KARABINER_DIR="$HOME/.config/karabiner/assets/complex_modifications"
  mkdir -p "$KARABINER_DIR"
  cp karabiner/claude-controller.json "$KARABINER_DIR/"
  echo "  ✅ Karabiner 규칙 복사됨 → $KARABINER_DIR/claude-controller.json"
  echo "     (Complex Modifications → Add rule → 'claude-controller' 활성화)"
else
  echo "  ℹ️  Karabiner-Elements 없음 — 매크로패드(선택 기능)를 쓸 때만 필요. ADVANCED_MACROPAD.md 참고"
fi

echo
echo "다음 단계:"
echo "  1) 폰 준비: 아이폰은 개인용 핫스팟 + USB / 안드로이드는 USB 디버깅 (README 참고)"
echo "  2) 데몬 실행: yarn start"
echo "  3) 폰 브라우저에서 대시보드 열기 → 홈 화면에 추가(PWA)"
echo "  4) ~/.zshrc에 추가: source $(pwd)/shell/cl.sh  →  프로젝트에서 cl로 실행"
echo "     (tmux는 다이얼 기능에만 필요 — cl이 자동으로 tmux 안에서 claude를 띄움)"
