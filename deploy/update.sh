#!/usr/bin/env bash
# 把主機上的 FastAPI 更新到指定的 commit，健康檢查沒過就退回原本的版本。
# 由 .github/workflows/deploy.yml 在主機的 runner 上執行，也可以手動執行：update.sh <commit>
#
# 公開 repo 的 Actions log 人人可讀，所以畫面上只印狀態，細節寫進主機上的 logs/update.log。
set -euo pipefail

target="${1:?usage: update.sh <commit>}"
root="$HOME/pjqaqc-deployment"
code="$root/code"

export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"

mkdir -p "$root/logs"
exec 3>&1 >>"$root/logs/update.log" 2>&1
trap 'echo "::error::The update stopped early. See logs/update.log on the host." >&3' ERR

say() {
  echo "$*" >&3
  echo "$(date -Is) $*"
}

apply() {
  git -C "$code" checkout --quiet --detach "$1" \
    && (cd "$code/backend" && "$root/bin/uv" sync --locked --no-dev) \
    && mkdir -p "$HOME/.config/systemd/user" \
    && install -m 644 "$code"/deploy/*.service "$HOME/.config/systemd/user/" \
    && systemctl --user daemon-reload \
    && systemctl --user restart pjqaqc-api
}

# 正式環境只接受帶共用密鑰的請求。密鑰經 stdin 交給 curl，不會出現在程序清單。
# 這個路由不需要登入，能回 200 代表程式成功匯入、讀到設定，且中介層正常運作。
healthy() {
  local attempt
  for attempt in $(seq 1 30); do
    if systemctl --user is-active --quiet pjqaqc-api \
      && printf 'X-PJQAQC-Edge: %s\n' "$(tr -d '\r\n' < "$root/secrets/edge_secret")" \
        | curl --silent --fail --max-time 3 --output /dev/null --header @- \
          http://127.0.0.1:18741/api/auth/session; then
      return 0
    fi
    sleep 2
  done
  return 1
}

git -C "$code" fetch --quiet origin main
target="$(git -C "$code" rev-parse --verify "$target^{commit}")"
previous="$(git -C "$code" rev-parse HEAD)"
short="${target:0:7}"

if ! git -C "$code" merge-base --is-ancestor "$target" origin/main; then
  say "::error::$short is not on main, so it will not be deployed."
  exit 1
fi

# 重新執行舊的工作流程時不會把主機往回帶；要回復舊版請依 DEPLOYMENT.md 手動操作。
if git -C "$code" merge-base --is-ancestor "$target" "$previous"; then
  say "The host is already at or past $short."
  exit 0
fi

if git -C "$code" diff --quiet "$previous" "$target" -- backend deploy; then
  git -C "$code" checkout --quiet --detach "$target"
  say "$short does not change the backend, so the API was not restarted."
  exit 0
fi

say "Updating the API to $short."
if apply "$target" && healthy; then
  say "The API is healthy on $short."
  exit 0
fi

say "::error::$short did not come up healthy. Rolling back to ${previous:0:7}."
if apply "$previous" && healthy; then
  say "Rolled back. The API is healthy on ${previous:0:7}."
else
  say "::error::The rollback also failed. The API needs attention on the host."
fi
exit 1
