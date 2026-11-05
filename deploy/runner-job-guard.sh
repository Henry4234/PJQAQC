#!/usr/bin/env bash
# 主機上的 runner 在每個工作開始前執行這支程式，結束碼不是 0 時工作就不會執行。
#
# 這是公開 repo：任何人都能 fork，再自己寫一個指定這台 runner 的 workflow 來開 PR。
# workflow 檔裡的條件由對方控制，攔不住這種情況，所以必須在主機這一端檢查。
# GITHUB_* 由 GitHub 提供，workflow 無法覆寫。
set -eu

repository="Henry4234/PJQAQC"
workflow="$repository/.github/workflows/deploy.yml@refs/heads/main"

if [ "${GITHUB_REPOSITORY:-}" = "$repository" ] \
  && [ "${GITHUB_WORKFLOW_REF:-}" = "$workflow" ] \
  && [ "${GITHUB_REF:-}" = "refs/heads/main" ]; then
  case "${GITHUB_EVENT_NAME:-}" in
    workflow_run | workflow_dispatch) exit 0 ;;
  esac
fi

echo "::error::This runner only accepts the deploy workflow on main."
exit 1
