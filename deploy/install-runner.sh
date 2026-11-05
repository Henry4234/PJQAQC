#!/usr/bin/env bash
# 在主機上安裝只負責部署的 GitHub Actions runner。只需執行一次，步驟見 DEPLOYMENT.md〈自動部署〉。
# 這支程式不會更新或重啟 FastAPI。
set -euo pipefail

version=2.338.2
case "$(uname -m)" in
  x86_64)
    arch=x64
    sha256=baebf204307bac6193480852732f0aba2ae97b6c5597c244f4d5558390147c40
    ;;
  aarch64)
    arch=arm64
    sha256=670adb2f268fe21dcbb58b3db0e0aa9d5b3bddfe2c651481336e561ff86de945
    ;;
  *)
    echo "Unsupported architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

root="$HOME/pjqaqc-deployment"
runner="$root/runner"
units="$HOME/.config/systemd/user"
archive="actions-runner-linux-$arch-$version.tar.gz"

# 從提示輸入，權杖才不會留在 shell 歷史紀錄。
read -rsp "Runner registration token: " token
echo
if [ -z "$token" ]; then
  echo "A registration token is required." >&2
  exit 1
fi

# 主機的 checkout 由 update.sh 管理，所以這裡直接讀 origin/main，不切換版本。
# 明確指定 ref：checkout 只追蹤單一分支時，fetch origin main 不會更新 origin/main。
git -C "$root/code" fetch --quiet origin +refs/heads/main:refs/remotes/origin/main
mkdir -p "$runner" "$root/bin" "$units"
git -C "$root/code" show origin/main:deploy/runner-job-guard.sh > "$root/bin/runner-job-guard.sh"
chmod 700 "$root/bin/runner-job-guard.sh"
git -C "$root/code" show origin/main:deploy/pjqaqc-runner.service > "$units/pjqaqc-runner.service"

cd "$runner"
curl --silent --show-error --fail --location --output "$archive" \
  "https://github.com/actions/runner/releases/download/v$version/$archive"
echo "$sha256  $archive" | sha256sum --check --quiet
tar xzf "$archive"
rm "$archive"

# --no-default-labels 拿掉 self-hosted 等通用標籤，只有明確指定 pjqaqc-prod 的工作才會排到這裡。
./config.sh --unattended --replace \
  --url https://github.com/Henry4234/PJQAQC \
  --token "$token" \
  --name pjqaqc-prod \
  --labels pjqaqc-prod \
  --no-default-labels \
  --work _work

systemctl --user daemon-reload
systemctl --user enable --now pjqaqc-runner
systemctl --user is-active pjqaqc-runner
