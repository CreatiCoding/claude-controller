# claude-controller: tmux 안에서 claude를 실행하는 함수 (다이얼 기능 전제 충족용)
#
# 사용법: ~/.zshrc(또는 ~/.bashrc)에 아래 한 줄 추가
#   source /path/to/claude-controller/shell/cld.sh
#
# 그다음 프로젝트 폴더에서 `cld` 실행:
#   - tmux 밖이면: 프로젝트별 tmux 세션(claude-<폴더명>)을 만들고 그 안에서 claude 실행.
#     같은 폴더에서 다시 실행하면 기존 세션에 다시 붙는다(-A). claude 종료 시 세션도 닫힘.
#   - 이미 tmux 안이면: 그냥 claude 실행.
#   - 인자는 claude에 그대로 전달: cld --resume
#     (tmux 경유 시 인자가 공백 기준으로 합쳐지므로, 공백 포함 인자가 필요하면 tmux 안에서 claude를 직접 실행할 것)
#
# 함수 이름이 마음에 안 들면 아래 cld를 원하는 이름으로 바꾸면 된다.

cld() {
  if ! command -v tmux >/dev/null 2>&1; then
    echo "cld: tmux가 없습니다 (brew install tmux). 일단 tmux 없이 claude를 실행합니다." >&2
    claude "$@"
    return
  fi

  if [ -n "$TMUX" ]; then
    claude "$@"
    return
  fi

  # 프로젝트별 세션 이름 (tmux가 허용하지 않는 문자는 _로)
  local base name
  base=$(basename "$PWD")
  base=$(printf '%s' "$base" | tr -c 'a-zA-Z0-9_-' '_')
  name="claude-$base"

  tmux new-session -A -s "$name" -c "$PWD" "claude $*"
}
