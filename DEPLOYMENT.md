# PJQAQC 上線手冊

## 架構

| 使用者 | 連線路徑 | 資料 |
| --- | --- | --- |
| 訪客（DEMO 模式） | 瀏覽器 → Cloudflare Worker 靜態檔 | 瀏覽器內的合成資料，不連後端也不連資料庫 |
| 編輯者 | 瀏覽器 → Cloudflare Worker → Workers VPC → Tunnel → FastAPI → Supabase | 正式資料，可編輯 |
| 維護 | 管理員裝置 → Tailscale → Ubuntu SSH | 不經過這條路徑提供 API |

入口網站只有一個。未登入就是 DEMO；由右上角登入通過後才是編輯者模式。

- **流量**：靜態檔不計入 Worker 請求額度。沒有工作階段 cookie 的 `/api/*` 請求在 Worker 就結束，訪客再多也不會碰到 FastAPI 或 Supabase。
- **帳號**：帳號密碼由 Supabase Auth 管理。FastAPI 驗證密碼後，檢查 `app_metadata.pjqaqc_access`，再簽發 30 分鐘的 HttpOnly cookie。
- **只能經 Worker 進入**：FastAPI 沒有公開網址，只綁在主機的 `127.0.0.1`，區網和 Tailscale 都連不到（`tests/private-api.test.mjs` 會檢查設定）。唯一路徑是 Worker 經 Workers VPC 進 Tunnel。FastAPI 另外要求 Worker 的共用密鑰，其他請求一律回 404。
- **防護分層**：Worker 擋掉匿名請求與跨站寫入，並對登入與 API 限速；真正的權限檢查在 FastAPI。
- **稽核紀錄**：`qc_results` 等品管與校正紀錄只能新增。API 沒有修改或刪除的路由，`pjqaqc_app` 只有 `INSERT`、`SELECT` 權限，刪除上層主檔也不會連帶刪除；`tests/audit-tables.test.mjs` 會檢查每個遷移。
- **只有 DEMO 時**：Worker 未設定後端也能運作，DEMO 正常，只有登入會回 503。可以先上線 DEMO，之後再接後端。

## CI/CD

| 工作流程 | 觸發時機 | 內容 |
| --- | --- | --- |
| `ci.yml` | 每個 PR 與 `main` | Worker、DEMO 與部署設定測試，Worker 打包檢查，Compose 檢查，映像建置，登入與 AI 邊界測試 |
| `deploy.yml` | `main` 的 CI 通過後，或手動執行 | 先更新主機上的 FastAPI，成功後才部署 Worker |
| `deploy-database.yml` | `main` 的 `supabase/migrations/` 變更 | 列出並套用待執行的遷移（預設關閉） |

設定完成後，合併到 `main` 就不需要人工操作：

- CI 失敗時不會部署。
- FastAPI 更新後會做健康檢查，沒通過就自動退回原版本，Worker 也不會部署。
- 這次合併沒有改到 `backend/`、`deploy/` 時，API 不會重啟。

在 GitHub 的 Settings → Secrets and variables → Actions 設定下列項目。尚未設定時，對應的部署工作會略過，不會失敗。

| 名稱 | 類型 | 用途 |
| --- | --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Variable | 要部署到的 Cloudflare 帳號；設定後才會部署 Worker |
| `CLOUDFLARE_API_TOKEN` | `production` environment 的 Secret | 以「Edit Cloudflare Workers」範本建立的 API Token，並加上 Connectivity Directory 的 Bind 權限 |
| `BACKEND_DEPLOY_ENABLED` | Variable | 設為 `true` 才會更新主機上的 FastAPI；請在 runner 安裝好後才設定，見〈自動部署〉 |
| `SUPABASE_MIGRATIONS_ENABLED` | Variable | 設為 `true` 才會自動套用遷移 |
| `SUPABASE_DB_URL` | Secret | 維護帳號的 PostgreSQL 連線字串 |

部署工作都使用 `production` environment。請在 Settings → Environments → production 把 Deployment branches 限制為 `main`。若要在部署前由人工核准，再加上 Required reviewers。

## Supabase

專案為 `tptjijcynzwskfcgkvmx`。正式表與檢視都在 `qaqc` schema，此 schema 不在 Data API 的 Exposed schemas 內，瀏覽器無法直接查詢；所有存取都經過 FastAPI 的 `pjqaqc_app` 帳號。

### 編輯者帳號

1. 在 Authentication → Sign In / Providers 關閉 **Allow new users to sign up**。
2. 在 Authentication → Users 建立帳號，勾選 Auto Confirm User 並設定密碼。
3. 授予編輯權限。在 SQL Editor 執行：

   ```sql
   UPDATE auth.users
   SET raw_app_meta_data = raw_app_meta_data || '{"pjqaqc_access": true}'
   WHERE email = 'editor@example.com';
   ```

只有 Supabase 帳號存在但沒有這個權限時，登入會被拒絕。撤銷權限在下次登入時生效，已簽發的工作階段最長再持續 30 分鐘；若需立即終止全部工作階段，請替換 `secrets/session_key` 並重新建立 app 容器。

### 資料搬移

新的空白環境才需要。

1. 套用 [v3 migration](supabase/migrations/20261104233916_qaqc_v3.sql) 一次。
2. 在可同時連到 NAS 與 Supabase 的維護機器，使用有來源讀取權限的 MariaDB 設定。由 Supabase Connect → Direct → Session pooler 取得主機，並在 Database → Settings → SSL Configuration 下載公開 CA 憑證。透過維護機器的祕密管理方式提供 `MIGRATION_DATABASE_URL`，連線字串需使用 `sslmode=verify-full`、指向下載憑證的 `sslrootcert`，並使用能寫入 `qaqc` 的維護帳號。
3. 先執行預設演練。工具逐表驗證筆數與外鍵，成功後回滾。正式切換前，暫停 MariaDB 寫入、完成備份，再加 `--commit` 匯入空的目標。核對 22 張表的筆數並保留來源備份。工具遇到已含資料的目標會中止。

   ```bash
   cd backend
   uv sync --locked
   uv run python migrate_to_postgres.py --source-env /secure/path/mariadb.env
   uv run python migrate_to_postgres.py --source-env /secure/path/mariadb.env --commit
   ```

4. 用維護帳號透過 `psql` 執行 `\password pjqaqc_app` 設定獨立高強度密碼，再執行 `ALTER ROLE pjqaqc_app LOGIN;`。Session pooler 的登入名稱為 `pjqaqc_app.<project-ref>`，埠為 `5432`。用此帳號產生正式站 DSN，密碼需做 URL 編碼，查詢參數使用 `sslmode=verify-full&sslrootcert=/run/secrets/supabase_ca`。

### 啟用自動遷移

正式庫的遷移紀錄有 4 筆先前手動操作留下的版本，repo 內沒有對應檔案，因此 `db push` 會拒絕執行。第一次啟用前，由維護機器修復一次：

```bash
npx supabase@3.0.0 migration repair --remote="$SUPABASE_DB_URL" --status reverted \
  20261104155236 20261104161047 20261104161124 20261104174221 --yes
npx supabase@3.0.0 db push --remote="$SUPABASE_DB_URL" --dry-run   # 應顯示 Remote database is up to date
```

這只更新遷移紀錄表，不會改動資料或結構。

## 部署 FastAPI

FastAPI 以 systemd 使用者服務跑在 Ubuntu 主機的一般帳號下，只綁 `127.0.0.1`，這個帳號不需要 sudo 或 Docker 權限。主機的 Tailscale 位址不寫進這個公開 repo。

### 維護連線

SSH 應只對 Tailscale 開放，不對區網或網際網路開放：

```bash
sudo apt install -y openssh-server
sudo systemctl enable --now ssh
sudo ufw allow in on tailscale0 to any port 22 proto tcp
```

### Ubuntu 網路條件

保持既有入站限制。Tunnel 只由主機向外連線，不需要開放任何入站埠。

| 出站目的 | 用途 |
| --- | --- |
| 核准的 DNS 解析器 | 查詢 Tunnel 與 PostgreSQL 主機 |
| `region1.v2.argotunnel.com`、`region2.v2.argotunnel.com` 的 TCP 或 UDP `7844` | Cloudflare Tunnel。若只允許 TCP，使用 HTTP/2 |
| `tptjijcynzwskfcgkvmx.supabase.co:443` | FastAPI 的 Supabase Auth 電子郵件與密碼驗證 |
| `aws-0-ap-northeast-1.pooler.supabase.com` TCP `5432` | PJQAQC 的 Session pooler，供 FastAPI 與搬移工具使用 PostgreSQL TLS |
| `github.com`、GitHub Actions 服務與 Python 套件來源 HTTPS `443` | 更新程式與相依套件，以及 runner 接收部署工作 |

```bash
nc -vz -w 5 region1.v2.argotunnel.com 7844
nc -vz -w 5 region2.v2.argotunnel.com 7844
nc -vz -w 5 aws-0-ap-northeast-1.pooler.supabase.com 5432
curl --silent --show-error --max-time 8 --output /dev/null --write-out '%{http_code}
'   https://tptjijcynzwskfcgkvmx.supabase.co/auth/v1/health
```

### 主機上的配置

全部放在 `~/pjqaqc-deployment/`：

| 路徑 | 內容 |
| --- | --- |
| `code/` | 這個 repo 的 checkout |
| `app.env` | `PUBLIC_HOSTNAME`、`SUPABASE_URL`、`SUPABASE_PUBLISHABLE_KEY`，範本為 `.env.production.sample` |
| `bin/uv` | Python 套件工具 |
| `secrets/` | 目錄權限 `0700`，檔案權限 `0600`，內容如下 |

| 檔案 | 內容 |
| --- | --- |
| `secrets/database_url` | `pjqaqc_app` 的 DSN，`sslrootcert` 指向下面的 `supabase_ca` |
| `secrets/supabase_ca` | 從 Supabase 下載的公開憑證 |
| `secrets/session_key` | `openssl rand -hex 32 > secrets/session_key` |
| `secrets/edge_secret` | `openssl rand -hex 32 > secrets/edge_secret` |
| `secrets/cloudflared_token` | Tunnel token，見〈連接 Worker 與 FastAPI〉 |

### 首次安裝

```bash
loginctl enable-linger "$USER"   # 讓服務在登出後繼續執行，可能需要 sudo
cd ~/pjqaqc-deployment
git clone https://github.com/Henry4234/PJQAQC.git code
(cd code/backend && ../../bin/uv sync --locked --no-dev)
install -m 644 code/deploy/*.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now pjqaqc-api pjqaqc-tunnel
```

### 自動部署

`deploy.yml` 的 `api` 工作在這台主機的 GitHub Actions runner 上執行 [`deploy/update.sh`](deploy/update.sh)。runner 只由主機向外連線到 GitHub，不開放任何入站埠，也不需要 sudo 或 Docker 權限。

安裝只需一次，要依序進行：

1. 在已登入 `gh` 的管理機器，先要求所有外部貢獻者的 PR 都要核准才能執行工作流程，再取得 runner 註冊權杖（1 小時內有效）。

   ```bash
   gh api -X PUT repos/Henry4234/PJQAQC/actions/permissions/fork-pr-contributor-approval \
     -f approval_policy=all_external_contributors
   gh api -X POST repos/Henry4234/PJQAQC/actions/runners/registration-token --jq .token
   ```

2. 在主機安裝 runner，並貼上權杖。若 `config.sh` 回報缺少系統函式庫，請執行 `sudo ~/pjqaqc-deployment/runner/bin/installdependencies.sh` 後再跑一次。

   ```bash
   cd ~/pjqaqc-deployment/code
   git fetch origin +refs/heads/main:refs/remotes/origin/main
   git show origin/main:deploy/install-runner.sh > /tmp/install-runner.sh
   bash /tmp/install-runner.sh
   ```

3. 確認 runner 上線後，啟用部署，並可立即部署一次。

   ```bash
   gh api repos/Henry4234/PJQAQC/actions/runners --jq '.runners[] | "\(.name) \(.status)"'
   gh variable set BACKEND_DEPLOY_ENABLED --body true
   gh workflow run deploy.yml
   ```

暫停部署時，把 `BACKEND_DEPLOY_ENABLED` 設為 `false`。主機離線時，`api` 工作和後面的 Worker 部署都會排隊等候 runner；若要先部署前端，也是先設為 `false`，再重新執行工作流程。

#### 這台 runner 的風險與防護

GitHub [不建議公開 repo 使用 self-hosted runner](https://docs.github.com/en/actions/reference/security/secure-use)，因為任何人都能 fork 後自己寫一個指定這台 runner 的 workflow 來開 PR。防護方式如下，其中第一項是主要防線：

- **主機端檢查**：runner 在每個工作開始前執行 [`runner-job-guard.sh`](deploy/runner-job-guard.sh)，不是 `main` 上的 `deploy.yml` 就拒絕，工作不會執行。這支程式裝在 checkout 之外，檢查的 `GITHUB_*` 由 GitHub 提供，workflow 無法覆寫。
- **專用標籤**：runner 只有 `pjqaqc-prod` 標籤，一般的 `self-hosted` 工作不會排到這裡。
- **人工核准**：外部貢獻者的 PR 要核准才會執行工作流程。請不要核准會改動 `.github/workflows/` 的外部 PR。
- **工作內容最少**：`api` 工作不使用第三方 action，也拿不到 GitHub secrets；`tests/deploy.test.mjs` 會檢查這些設定。

仍然存在的風險：

- runner 與 FastAPI 使用同一個帳號，**能合併到 `main` 的人就能在這個帳號下執行程式**，也讀得到 `secrets/`。自動部署本來就有這層信任，因此請維持 `main` 的合併權限與 GitHub 帳號的安全。
- 公開 repo 的 Actions log 人人可讀。`update.sh` 只在畫面印狀態，細節寫在主機的 `~/pjqaqc-deployment/logs/update.log`。之後修改 `api` 工作時，不要印出主機資訊。

### 手動更新與回復

自動部署失敗時會自己退回。需要手動操作時：

```bash
cd ~/pjqaqc-deployment/code
git fetch origin +refs/heads/main:refs/remotes/origin/main
git checkout --detach origin/main
(cd backend && ../../bin/uv sync --locked --no-dev)
systemctl --user restart pjqaqc-api
```

回復舊版時把 `origin/main` 換成要回復的 commit，並把 `BACKEND_DEPLOY_ENABLED` 設為 `false`，否則下一次合併會再更新到最新版。服務檔有變更時，要再執行一次 `install` 與 `daemon-reload`；`pjqaqc-tunnel` 不會自動重啟。正式環境預設關閉 AI 判讀。

### 連接 Worker 與 FastAPI

使用 Workers VPC，不要在 Tunnel 發布公開 hostname，FastAPI 才不會有任何公開網址。Workers VPC 目前為 beta。以下指令在已登入 Cloudflare 的管理機器執行。

1. 建立 Tunnel，並把 token 存入主機的 `secrets/cloudflared_token`。Token 可由 Cloudflare API 的 `GET /accounts/<account-id>/cfd_tunnel/<tunnel-id>/token` 取得。

   ```bash
   npx wrangler@4.119.0 tunnel create pjqaqc-api
   ```

2. 建立只指向 FastAPI 的 VPC service，並把回傳的 id 填入 `cloudflare/wrangler.toml` 的 `[[vpc_services]]`。

   ```bash
   npx wrangler@4.119.0 vpc service create pjqaqc-api      --type http --tunnel-id <tunnel-id> --ipv4 127.0.0.1 --http-port 18741
   ```

3. 部署 Worker，再設定與主機相同的共用密鑰。密鑰會保留在 Cloudflare，之後部署不用重設。

   ```bash
   npx wrangler@4.119.0 deploy --config cloudflare/wrangler.toml
   ssh <主機> 'tr -d "
" < ~/pjqaqc-deployment/secrets/edge_secret'      | npx wrangler@4.119.0 secret put EDGE_SHARED_SECRET --config cloudflare/wrangler.toml
   ```

### 改用 Docker（選用）

`compose.yaml` 提供更強的隔離（唯讀檔案系統、移除 capabilities、專用非 root 使用者），CI 也會建置並測試映像。代價是帳號要加入 `docker` 群組，這個權限近似 root。要切換時：

1. 複製 `app.env` 為 `.env.production`，把上述 secrets 放在 repo 的 `secrets/`，並讓容器程序讀得到。
2. 把 VPC service 改為 `--hostname app --http-port 8000`。
3. 停用兩個使用者服務，再執行 `docker compose --env-file .env.production up -d --build`。

## 驗收

- 以無痕視窗開啟入口網站：右上角顯示 DEMO 與登入按鈕，各頁都有資料，沒有編輯按鈕。開發者工具的 Network 中，`/api/` 只會出現 `/api/auth/session`。
- 以未授權的 Supabase 帳號登入，應被拒絕。
- 以編輯者帳號登入：右上角顯示編輯者模式與帳號，看到的是正式資料。用核准的測試資料修改一個儀器參數並登錄一筆品管結果，重新整理後資料仍在。
- 登出後回到 DEMO。
- 從 Tailscale 上的另一台裝置確認 SSH 可連，但 FastAPI 連不到：`nc -vz -w 5 <主機的 Tailscale 位址> 18741` 應失敗。
- 在主機執行 `ss -tln | grep 18741`，應只看到 `127.0.0.1`。
- 核對 Tunnel 狀態、Supabase Auth 登入紀錄及資料庫用量。

## 維運注意事項

- Supabase Free 的資料庫容量為 500 MB，低活動約一週可能暫停。定期以維護帳號對 `qaqc` 做加密的異地備份，實際還原到獨立環境驗證。
- 搬移切換前保留 MariaDB 快照。切換後若正式站已產生新寫入，回復來源前先保存並核對新增資料。
- 公開 GitHub repo 歷史含先前追蹤的 SQL 備份和樣本資料。請確認其公開授權，正式匯出與資料庫密碼應保存在受控位置。
- 已記錄的品管結果與校正事件是稽核紀錄：`pjqaqc_app` 只有新增權限，沒有修改與刪除權限。修改目標值請透過平測建立新版本。

## 參考文件

- [GitHub Actions 的安全使用](https://docs.github.com/en/actions/reference/security/secure-use)
- [在工作前後執行 runner 腳本](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/run-scripts)
- [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/)
- [Workers Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
- [Workers VPC](https://developers.cloudflare.com/workers-vpc/)
- [Cloudflare Tunnel 出站規則](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/tunnel-with-firewall/)
- [Supabase 密碼登入](https://supabase.com/docs/guides/auth/passwords)
- [Supabase PostgreSQL 連線](https://supabase.com/docs/guides/database/connecting-to-postgres)
- [Supabase 免費方案暫停](https://supabase.com/docs/guides/platform/free-project-pausing)及[資料庫備份](https://supabase.com/docs/guides/platform/backups)
- [Docker 與 Ubuntu 防火牆](https://docs.docker.com/engine/install/ubuntu/)
