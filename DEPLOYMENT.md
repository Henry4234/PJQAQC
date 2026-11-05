# PJQAQC 上線手冊

## 架構

| 使用者 | 連線路徑 | 資料 |
| --- | --- | --- |
| 訪客（DEMO 模式） | 瀏覽器 → Cloudflare Worker 靜態檔 | 瀏覽器內的合成資料，不連後端也不連資料庫 |
| 編輯者 | 瀏覽器 → Cloudflare Worker → Tunnel → FastAPI → Supabase | 正式資料，可編輯 |
| 維護 | 管理員裝置 → Tailscale → Ubuntu SSH | |

入口網站只有一個。未登入就是 DEMO；由右上角登入通過後才是編輯者模式。

- **流量**：靜態檔不計入 Worker 請求額度。沒有工作階段 cookie 的 `/api/*` 請求在 Worker 就結束，訪客再多也不會碰到 FastAPI 或 Supabase。
- **帳號**：帳號密碼由 Supabase Auth 管理。FastAPI 驗證密碼後，檢查 `app_metadata.pjqaqc_access`，再簽發 30 分鐘的 HttpOnly cookie。
- **防護分層**：Worker 擋掉匿名請求與跨站寫入，並對登入與 API 限速；真正的權限檢查在 FastAPI。FastAPI 只接受帶 `EDGE_SHARED_SECRET` 的請求，其他一律回 404。
- **只有 DEMO 時**：Worker 未設定後端也能運作，DEMO 正常，只有登入會回 503。可以先上線 DEMO，之後再接後端。

## CI/CD

| 工作流程 | 觸發時機 | 內容 |
| --- | --- | --- |
| `ci.yml` | 每個 PR 與 `main` | Worker 與 DEMO 測試、Worker 打包檢查、Compose 檢查、映像建置、登入邊界測試 |
| `deploy-portal.yml` | `main` 的 `frontend/`、`cloudflare/`、`tests/` 變更 | 重跑測試後部署 Worker |
| `deploy-api.yml` | `main` 的 `backend/`、`Dockerfile` 變更 | 建置、測試映像，再推送到 `ghcr.io/henry4234/pjqaqc-api` |
| `deploy-database.yml` | `main` 的 `supabase/migrations/` 變更 | 列出並套用待執行的遷移（預設關閉） |

在 GitHub 的 Settings → Secrets and variables → Actions 設定下列項目。尚未設定時，部署工作會略過，不會失敗。

| 名稱 | 類型 | 用途 |
| --- | --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Variable | 要部署到的 Cloudflare 帳號；設定後才會部署入口網站 |
| `CLOUDFLARE_API_TOKEN` | Secret | 以「Edit Cloudflare Workers」範本建立的 API Token |
| `API_ORIGIN` | Variable | FastAPI 的位址，見〈連接 Worker 與 FastAPI〉 |
| `EDGE_SHARED_SECRET` | Secret | 與伺服器 `secrets/edge_secret` 相同的值 |
| `SUPABASE_MIGRATIONS_ENABLED` | Variable | 設為 `true` 才會自動套用遷移 |
| `SUPABASE_DB_URL` | Secret | 維護帳號的 PostgreSQL 連線字串 |

部署工作都使用 `production` environment。若要在部署前由人工核准，請在 Settings → Environments → production 加上 Required reviewers。

Ubuntu 上的 FastAPI 更新由管理員執行，流程見〈部署 FastAPI〉。CI 只負責產出已測試的映像。

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

### Ubuntu 網路條件

保持既有入站限制。Compose 未發布主機連接埠，`cloudflared` 和 FastAPI 透過專用 Docker 網路通訊。

| 出站目的 | 用途 |
| --- | --- |
| 核准的 DNS 解析器 | 查詢 Tunnel 與 PostgreSQL 主機 |
| `region1.v2.argotunnel.com`、`region2.v2.argotunnel.com` 的 TCP 或 UDP `7844` | Cloudflare Tunnel。若只允許 TCP，使用 HTTP/2 |
| `tptjijcynzwskfcgkvmx.supabase.co:443` | FastAPI 的 Supabase Auth 電子郵件與密碼驗證 |
| `aws-0-ap-northeast-1.pooler.supabase.com` TCP `5432` | PJQAQC 的 Session pooler，供 FastAPI 與搬移工具使用 PostgreSQL TLS |
| `ghcr.io` 與核准的映像來源 HTTPS `443` | 下載映像 |

在 Ubuntu 執行連線檢查，並從實際容器網路再測一次。

```bash
nc -vz -w 5 region1.v2.argotunnel.com 7844
nc -vz -w 5 region2.v2.argotunnel.com 7844
nc -vz -w 5 "$SUPABASE_POOLER_HOST" 5432
curl --silent --show-error --max-time 8 --output /dev/null --write-out '%{http_code}\n' \
  https://tptjijcynzwskfcgkvmx.supabase.co/auth/v1/health
```

### 設定與啟動

在部署目錄複製 `.env.production.sample` 為 `.env.production` 並填入。`PUBLIC_HOSTNAME` 必須等於入口網站的網域。用權限 `0700` 的 `secrets/` 目錄保存下列檔案；檔案需能被各自的非 root 容器程序讀取。

| 檔案 | 內容 |
| --- | --- |
| `secrets/database_url` | `pjqaqc_app` 的 DSN |
| `secrets/supabase_ca` | 從 Supabase 下載的公開憑證 |
| `secrets/cloudflared_token` | Tunnel token |
| `secrets/session_key` | `openssl rand -hex 32 > secrets/session_key` |
| `secrets/edge_secret` | `openssl rand -hex 32 > secrets/edge_secret`，同一個值填入 GitHub 的 `EDGE_SHARED_SECRET` |

```bash
docker compose --env-file .env.production config --quiet
docker compose --env-file .env.production pull app
docker compose --env-file .env.production up -d
docker compose --env-file .env.production ps
```

更新時重複 `pull` 與 `up -d`。在 `.env.production` 指定 `API_IMAGE` 為前一個 commit SHA 即可回復。正式環境預設關閉 AI 判讀。

### 連接 Worker 與 FastAPI

建立 remotely managed Tunnel，再擇一連接：

**A. Workers VPC（不需要網域，後端沒有公開網址）**：Workers VPC 目前為 beta。

```bash
npx wrangler@4.119.0 vpc service create pjqaqc-api \
  --type http --tunnel-id <tunnel-id> --hostname app --http-port 8000
```

把回傳的 service id 填入 `cloudflare/wrangler.toml` 的 `[[vpc_services]]`（取消註解），並設定 `API_ORIGIN=http://app:8000`。

**B. Tunnel 公開網址（需要 Cloudflare 上的網域）**：在 Tunnel 發布一個 hostname，服務填 `http://app:8000`，並設定 `API_ORIGIN=https://<該 hostname>`。此網址雖然公開，但沒有 `EDGE_SHARED_SECRET` 的請求一律回 404。

## 驗收

- 以無痕視窗開啟入口網站：右上角顯示 DEMO 與登入按鈕，各頁都有資料，沒有編輯按鈕。開發者工具的 Network 中，`/api/` 只會出現 `/api/auth/session`。
- 以未授權的 Supabase 帳號登入，應被拒絕。
- 以編輯者帳號登入：右上角顯示編輯者模式與帳號，看到的是正式資料。用核准的測試資料修改一個儀器參數並登錄一筆品管結果，重新整理後資料仍在。
- 登出後回到 DEMO。
- 在 Ubuntu 驗證 SSH 經核准的維護路徑可達，FastAPI 容器沒有發布主機埠。
- 核對 Tunnel 狀態、Supabase Auth 登入紀錄及資料庫用量。

## 維運注意事項

- Supabase Free 的資料庫容量為 500 MB，低活動約一週可能暫停。定期以維護帳號對 `qaqc` 做加密的異地備份，實際還原到獨立環境驗證。
- 搬移切換前保留 MariaDB 快照。切換後若正式站已產生新寫入，回復來源前先保存並核對新增資料。
- 公開 GitHub repo 歷史含先前追蹤的 SQL 備份和樣本資料。請確認其公開授權，正式匯出與資料庫密碼應保存在受控位置。
- 已記錄的品管結果與校正事件是稽核紀錄：`pjqaqc_app` 只有新增權限，沒有修改與刪除權限。修改目標值請透過平測建立新版本。

## 參考文件

- [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/)
- [Workers Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
- [Workers VPC](https://developers.cloudflare.com/workers-vpc/)
- [Cloudflare Tunnel 出站規則](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/tunnel-with-firewall/)
- [Supabase 密碼登入](https://supabase.com/docs/guides/auth/passwords)
- [Supabase PostgreSQL 連線](https://supabase.com/docs/guides/database/connecting-to-postgres)
- [Supabase 免費方案暫停](https://supabase.com/docs/guides/platform/free-project-pausing)及[資料庫備份](https://supabase.com/docs/guides/platform/backups)
- [Docker 與 Ubuntu 防火牆](https://docs.docker.com/engine/install/ubuntu/)
