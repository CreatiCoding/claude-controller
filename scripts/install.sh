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
if [ -d "/Applications/Karabiner-Elements.app" ]; then
  echo "  ✅ Karabiner-Elements 설치됨"
else
  echo "  ⚠️  Karabiner-Elements 없음 — brew install --cask karabiner-elements (MDM 차단 시 README의 플랜 B 참고)"
fi

# Karabiner 규칙 파일 복사 (설정 디렉터리가 있으면)
KARABINER_DIR="$HOME/.config/karabiner/assets/complex_modifications"
mkdir -p "$KARABINER_DIR"
cp karabiner/claude-controller.json "$KARABINER_DIR/"
echo "  ✅ Karabiner 규칙 복사됨 → $KARABINER_DIR/claude-controller.json"

echo
echo "다음 단계:"
echo "  1) Karabiner-Elements → Complex Modifications → Add rule → 'claude-controller' 규칙 활성화"
echo "  2) 폰: USB 디버깅 켜고 USB 연결"
echo "  3) 데몬 실행: yarn start"
echo "  4) 폰 크롬에서 http://localhost:9200 열기 → 홈 화면에 추가(PWA)"
echo "  5) ~/.zshrc에 추가: source $(pwd)/shell/cl.sh  →  프로젝트에서 cl로 실행"
echo "     (tmux는 다이얼 기능에만 필요 — cl이 자동으로 tmux 안에서 claude를 띄움)"
