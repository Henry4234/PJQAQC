# PJQAQC 上線手冊

公開展示使用 GitHub Pages，由 `main` 的 GitHub Actions 工作流程發布 `demo/` 中的三個靜態檔。展示資料是合成資料，瀏覽器無需連到正式站或資料庫。正式站由 Ubuntu 執行 FastAPI，同一個網域提供前端與 API。

## Cloudflare 前端預覽

Workers Static Assets 預覽以 `frontend/` 產生獨立的瀏覽版。儀表板、紀錄與 L-J 圖使用合成資料，預覽可在瀏覽器中離線查詢。下列指令會把生成的靜態檔發布到 `pjqaqc-frontend-preview` 的 `workers.dev` 網址。

```bash
node cloudflare/build-preview.mjs
npx wrangler@4.119.0 deploy --config cloudflare/wrangler.toml
```

正式整合時，請建立同來源的 Worker 路由，將首頁、`/login`、`/logout` 與 `/api/*` 經具名 Tunnel 和 Workers VPC Service 轉送 Ubuntu。FastAPI 驗證登入並使用受限帳號連 Supabase；私有頁面與 API 回應維持禁止快取。

## 正式部署

| 使用者 | 連線路徑 |
| --- | --- |
| 匿名瀏覽 | 瀏覽器 → GitHub Pages |
| 正式站操作 | 瀏覽器 → Cloudflare Tunnel → Ubuntu FastAPI → Supabase Auth 與 PostgreSQL |
| 維護 | 管理員裝置 → Tailscale → Ubuntu SSH |

## Ubuntu 網路條件

保持既有入站限制。Compose 未發布主機連接埠，`cloudflared` 和 FastAPI 透過專用 Docker 網路通訊。Tunnel 是讓核准人員透過 Cloudflare 進入應用程式的路徑，需要符合主機的資安政策。

| 出站目的 | 用途 |
| --- | --- |
| 核准的 DNS 解析器 | 查詢 Tunnel、Access 與 PostgreSQL 主機 |
| `region1.v2.argotunnel.com`、`region2.v2.argotunnel.com` 的 TCP 或 UDP `7844` | Cloudflare Tunnel。若只允許 TCP，使用 HTTP/2 |
| `tptjijcynzwskfcgkvmx.supabase.co:443` | FastAPI 的 Supabase Auth 電子郵件與密碼驗證 |
| `aws-0-ap-northeast-1.pooler.supabase.com` TCP `5432` | PJQAQC 的 Session pooler，供 FastAPI 與搬移工具使用 PostgreSQL TLS |
| 核准的 GitHub、映像倉庫與 Python 套件來源 HTTPS `443` | 更新程式與映像；可由核准的建置環境建好映像再交付 |

在 Ubuntu 執行連線檢查，並從實際容器網路再測一次。Docker 轉送流量的出站規則應由管理員驗證。

```bash
nc -vz -w 5 region1.v2.argotunnel.com 7844
nc -vz -w 5 region2.v2.argotunnel.com 7844
nc -vz -w 5 "$SUPABASE_POOLER_HOST" 5432
curl --silent --show-error --max-time 8 --output /dev/null --write-out '%{http_code}\n' \
  https://tptjijcynzwskfcgkvmx.supabase.co/auth/v1/health
```

Auth 健康端點回傳 HTTP 狀態表示 HTTPS 可達，應用程式登入時會另外提供 publishable key。Ubuntu 的 SSH 維護可經 Tailscale 進行，正式站使用者以瀏覽器登入。若 Ubuntu 禁止直連外部資料庫，需先核准受控出站路徑，並保留 PostgreSQL TLS 主機名驗證。

## Supabase 初始化與搬移

1. 選擇 PJQAQC 專案 `tptjijcynzwskfcgkvmx`。使用新的空白環境時，套用 [v3 migration](supabase/migrations/202611040001_qaqc_v3.sql) 一次。正式表與檢視都在 `qaqc` schema。此 schema 維持在 Data API 的 Exposed schemas 之外，專案只透過 PostgreSQL 使用時可停用 Data API。
2. 在可同時連到 NAS 與 Supabase 的維護機器，使用有來源讀取權限的 MariaDB 設定。由 Supabase Connect → Direct → Session pooler 取得主機，並在 Database → Settings → SSL Configuration 下載公開 CA 憑證。透過維護機器的祕密管理方式提供 `MIGRATION_DATABASE_URL`，連線字串需使用 `sslmode=verify-full`、指向下載憑證的 `sslrootcert`，並使用能寫入 `qaqc` 的維護帳號。
3. 先執行預設演練。工具逐表驗證筆數與外鍵，成功後回滾。正式切換前，暫停 MariaDB 寫入、完成備份，再加 `--commit` 匯入空的目標。核對 22 張表的筆數並保留來源備份。工具遇到已含資料的目標會中止。

```bash
cd backend
uv sync --locked
uv run python migrate_to_postgres.py --source-env /secure/path/mariadb.env
uv run python migrate_to_postgres.py --source-env /secure/path/mariadb.env --commit
```

4. 用維護帳號透過 `psql` 執行 `\password pjqaqc_app` 設定獨立高強度密碼，再執行 `ALTER ROLE pjqaqc_app LOGIN;`。Session pooler 的登入名稱為 `pjqaqc_app.<project-ref>`，埠為 `5432`。用此帳號產生正式站 DSN，密碼需做 URL 編碼，查詢參數使用 `sslmode=verify-full&sslrootcert=/run/secrets/supabase_ca`。

## 正式站帳號

在 Supabase Authentication 啟用 Email 登入並停用公開註冊。管理員建立已確認信箱且設有密碼的帳號，再使用 Supabase Auth Admin API 設定 `app_metadata.pjqaqc_access = true`。使用者以同一套帳號登入正式站後，可使用現有的讀寫管理功能。應用程式只用 publishable key 呼叫 Auth，帳號管理憑證由管理員另行保管。

登入工作階段長度為 30 分鐘。撤銷帳號授權會在下次登入時生效，已簽發的工作階段可持續到期。若需立即終止全部工作階段，可替換工作階段簽章金鑰並重新建立 app 容器。

## Cloudflare 與 Ubuntu 部署

1. 在 Cloudflare DNS 網域啟用後，選擇正式子網域。建立 remotely managed Tunnel，發布正式 hostname 並將服務填入 `http://app:8000`。將 HTTP Host Header 設為正式 hostname，並為該 hostname 啟用 HTTPS 重新導向與 Bypass Cache。正式站的登入頁由 FastAPI 提供。
2. 在 Ubuntu 的部署目錄複製 `.env.production.sample` 為 `.env.production`，填入 hostname 與 Supabase publishable key。用權限 `0700` 的 `secrets/` 目錄保存 `database_url`、`cloudflared_token` 和從 Supabase 下載的公開憑證 `supabase_ca`。使用 `openssl rand -hex 32 > secrets/session_key` 產生工作階段金鑰。在 Compose bind mount 中，檔案需能被各自的非 root 容器程序讀取。以受限父目錄保護來源檔，或由伺服器的祕密管理機制掛載。正式環境預設關閉 AI 判讀。
3. 執行下列命令部署服務。
4. 部署已驗證的 Git commit。GitHub Actions 負責檢查映像和 Compose 設定，Ubuntu 的部署由管理員透過 Tailscale 執行。保留上一個可部署 commit 與映像。正式站從登入到讀取資料驗證通過後再邀請使用者。

```bash
docker compose --env-file .env.production config --quiet
docker compose --env-file .env.production up -d --build
docker compose --env-file .env.production ps
```

## 驗收與維運

- 以匿名瀏覽器驗證展示頁可操作，正式網址會顯示登入頁，正式 API 回傳 HTTP 401。以已授權和未授權的 Supabase 帳號各驗證一次。登入後開啟 `/api/ready`，並用核准的測試資料驗證查詢與寫入。
- 在 Ubuntu 驗證 SSH 經核准的維護路徑可達，FastAPI 容器沒有發布主機埠。核對 Tunnel 狀態、Supabase Auth 登入紀錄及資料庫用量。
- Supabase Free 的資料庫容量為 500 MB，低活動約一週可能暫停。定期以維護帳號對 `qaqc` 做加密的異地備份，實際還原到獨立環境驗證。搬移切換前保留 MariaDB 快照。切換後若正式站已產生新寫入，回復來源前先保存並核對新增資料。
- 公開 GitHub repo 歷史含先前追蹤的 SQL 備份和樣本資料。請確認其公開授權，正式匯出與資料庫密碼應保存在受控位置。

參考文件

- [GitHub Pages 概覽](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)
- [Cloudflare Tunnel 出站規則](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/tunnel-with-firewall/)
- [Cloudflare Tunnel 發布路由](https://developers.cloudflare.com/tunnel/concepts/routing/)
- [Supabase 密碼登入](https://supabase.com/docs/guides/auth/passwords)及 [Auth 管理 API](https://supabase.com/docs/reference/javascript/auth-admin-updateuserbyid)
- [Docker 與 Ubuntu 防火牆](https://docs.docker.com/engine/install/ubuntu/)
- [Supabase PostgreSQL 連線](https://supabase.com/docs/guides/database/connecting-to-postgres)
- [Supabase 免費方案暫停](https://supabase.com/docs/guides/platform/free-project-pausing)及[資料庫備份](https://supabase.com/docs/guides/platform/backups)
