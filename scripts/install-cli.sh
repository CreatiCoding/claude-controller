#!/usr/bin/env bash
# claude-controller 를 npm publish 없이 로컬 바이너리로 설치한다.
#
#   curl -fsSL https://raw.githubusercontent.com/CreatiCoding/claude-controller/main/scripts/install-cli.sh | bash
#
# 하는 일:
#   1) 리포를 ~/.claude-controller/repo 에 클론(이미 있으면 git pull)  — 클론 안에서 실행하면 그 클론을 그대로 쓴다
#   2) 의존성 설치 + 대시보드 빌드 (yarn → corepack → npx corepack 순으로 폴백)
#   3) ~/.local/bin/claude-controller 래퍼 생성 (node <repo>/bin/claude-controller.js "$@")
#   4) PATH 안내, 다음 단계 안내
#
# 옵션(환경변수):
#   CC_REPO_DIR=경로   클론 위치 (기본 ~/.claude-controller/repo)
#   CC_BIN_DIR=경로    래퍼 위치 (기본 ~/.local/bin)
#   CC_REPO_URL=URL    클론할 리포 (기본 https://github.com/CreatiCoding/claude-controller.git)
#   CC_BRANCH=이름     체크아웃할 브랜치 (기본 main)
#   --uninstall        래퍼와 클론을 제거 (hook 제거는 먼저 `claude-controller uninstall-hooks`)
set -euo pipefail

REPO_URL="${CC_REPO_URL:-https://github.com/CreatiCoding/claude-controller.git}"
BRANCH="${CC_BRANCH:-main}"
BIN_DIR="${CC_BIN_DIR:-$HOME/.local/bin}"
WRAPPER="$BIN_DIR/claude-controller"

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m오류:\033[0m %s\n' "$*" >&2; exit 1; }

if [ "${1:-}" = "--uninstall" ]; then
  REPO_DIR="${CC_REPO_DIR:-$HOME/.claude-controller/repo}"
  rm -f "$WRAPPER" && log "래퍼 제거: $WRAPPER"
  if [ -d "$REPO_DIR" ]; then rm -rf "$REPO_DIR" && log "클론 제거: $REPO_DIR"; fi
  log "hook 등록이 남아 있으면 ~/.claude/settings.json 에서 hook-handler.js 항목을 지우세요 (제거 전 \`claude-controller uninstall-hooks\` 권장)"
  exit 0
fi

# ---- 0. 사전 조건
command -v git >/dev/null 2>&1 || die "git이 필요합니다 (xcode-select --install)"
command -v node >/dev/null 2>&1 || die "node가 필요합니다 (brew install node). 20.19 이상"
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
NODE_MINOR=$(node -p 'process.versions.node.split(".")[1]')
if [ "$NODE_MAJOR" -lt 20 ] || { [ "$NODE_MAJOR" -eq 20 ] && [ "$NODE_MINOR" -lt 19 ]; }; then
  die "node 20.19 이상이 필요합니다 (현재 $(node -v))"
fi

# ---- 1. 리포 위치 결정: 클론 안에서 실행 중이면 그 클론, 아니면 ~/.claude-controller/repo
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
if [ -n "${CC_REPO_DIR:-}" ]; then
  REPO_DIR="$CC_REPO_DIR"
elif [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/../bin/claude-controller.js" ]; then
  REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
  log "현재 클론을 사용: $REPO_DIR"
else
  REPO_DIR="$HOME/.claude-controller/repo"
fi

if [ -f "$REPO_DIR/bin/claude-controller.js" ]; then
  if [ -d "$REPO_DIR/.git" ] && [ -z "${CC_NO_PULL:-}" ] && [ "$REPO_DIR" != "${SCRIPT_DIR%/scripts}" ]; then
    log "기존 클론 갱신: $REPO_DIR"
    git -C "$REPO_DIR" pull --ff-only -q || log "pull 실패 — 현재 상태로 계속합니다"
  fi
else
  log "클론: $REPO_URL ($BRANCH) → $REPO_DIR"
  mkdir -p "$(dirname "$REPO_DIR")"
  git clone -q --branch "$BRANCH" --depth 1 "$REPO_URL" "$REPO_DIR"
fi

# ---- 2. 의존성 + 빌드 (yarn berry; 없으면 corepack; 그것도 없으면 npx corepack)
cd "$REPO_DIR"
if command -v yarn >/dev/null 2>&1; then YARN="yarn"
elif command -v corepack >/dev/null 2>&1; then corepack enable 2>/dev/null || true; YARN="corepack yarn"
else YARN="npx --yes corepack@latest yarn"; log "yarn/corepack 없음 — npx corepack으로 대신 실행"
fi
log "의존성 설치"
$YARN install --silent 2>/dev/null || $YARN install
log "대시보드 빌드"
$YARN build >/dev/null
[ -f dist/index.html ] || die "빌드 산출물(dist/index.html)이 없습니다"

# ---- 3. 래퍼 생성
mkdir -p "$BIN_DIR"
cat > "$WRAPPER" <<EOF
#!/usr/bin/env bash
# claude-controller 로컬 설치 래퍼 — scripts/install-cli.sh 가 생성. 리포: $REPO_DIR
exec node "$REPO_DIR/bin/claude-controller.js" "\$@"
EOF
chmod +x "$WRAPPER"
log "설치됨: $WRAPPER"

# ---- 4. 안내
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    log "PATH에 $BIN_DIR 이 없습니다. ~/.zshrc 에 추가:"
    echo "    export PATH=\"$BIN_DIR:\$PATH\""
    ;;
esac
echo
echo "다음 단계:"
echo "  claude-controller install-hooks   # Claude Code hook 등록"
echo "  claude-controller start           # 데몬 실행"
echo "  claude-controller doctor          # 환경 진단"
echo "  (~/.zshrc 에)  source $REPO_DIR/shell/ccode.sh   # ccode 명령 (tmux 다이얼용, 선택)"
echo
echo "갱신: 이 스크립트를 다시 실행하면 git pull + 재빌드.  제거: $0 --uninstall"
