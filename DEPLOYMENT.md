# PJQAQC 上線手冊

公開展示使用 GitHub Pages，由 `main` 的 GitHub Actions 工作流程發布 `demo/` 中的三個靜態檔。展示資料是合成資料，瀏覽器無需連到正式站或資料庫。正式站由 Ubuntu 執行 FastAPI，同一個網域提供前端與 API。

| 使用者 | 連線路徑 |
| --- | --- |
| 匿名瀏覽 | 瀏覽器 → GitHub Pages |
| 正式站操作 | 瀏覽器 → Cloudflare Access → Cloudflare Tunnel → Ubuntu FastAPI → Supabase |
| 維護 | 管理員裝置 → Tailscale → Ubuntu SSH |

## Ubuntu 網路條件

保持既有入站限制。Compose 未發布主機連接埠，`cloudflared` 和 FastAPI 透過專用 Docker 網路通訊。Tunnel 是讓核准人員透過 Cloudflare 進入應用程式的路徑，需要符合主機的資安政策。

| 出站目的 | 用途 |
| --- | --- |
| 核准的 DNS 解析器 | 查詢 Tunnel、Access 與 PostgreSQL 主機 |
| `region1.v2.argotunnel.com`、`region2.v2.argotunnel.com` 的 TCP 或 UDP `7844` | Cloudflare Tunnel。若只允許 TCP，使用 HTTP/2 |
| `<team>.cloudflareaccess.com:443` | FastAPI 驗證 Access JWT 使用的公開簽章金鑰 |
| `aws-0-ap-northeast-1.pooler.supabase.com` TCP `5432` | PJQAQC 的 Session pooler，供 FastAPI 與搬移工具使用 PostgreSQL TLS |
| 核准的 GitHub、映像倉庫與 Python 套件來源 HTTPS `443` | 更新程式與映像；可由核准的建置環境建好映像再交付 |

在 Ubuntu 執行連線檢查，並從實際容器網路再測一次。Docker 轉送流量的出站規則應由管理員驗證。

```bash
nc -vz -w 5 region1.v2.argotunnel.com 7844
nc -vz -w 5 region2.v2.argotunnel.com 7844
nc -vz -w 5 "$SUPABASE_POOLER_HOST" 5432
curl --fail --silent --show-error --output /dev/null \
  "https://$CF_ACCESS_TEAM.cloudflareaccess.com/cdn-cgi/access/certs"
```

若政策只允許應用程式透過 tailnet 存取，可改採 Tailscale Serve 和針對員工的 tailnet 存取政策。若 Ubuntu 也禁止直連外部資料庫，需先核准能透過 tailnet 抵達的受控出站節點，且只轉送到 Supabase 的指定目的地，保留 PostgreSQL TLS 主機名驗證。本手冊的 Compose 以 Cloudflare Access 驗證為前提。

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

## Cloudflare 與 Ubuntu 部署

1. Cloudflare DNS 網域啟用後，選擇正式子網域。在 Zero Trust 建立 Self-hosted Access 應用程式，保護完整子網域。使用明確的員工名單或身分提供者群組並要求 MFA。員工通過 Access 後會使用目前應用程式提供的同一套管理權限。
2. 建立 remotely managed Tunnel。發布正式 hostname，服務填入 `http://app:8000`，將 HTTP Host Header 設為正式 hostname，並在路由啟用 **Protect with Access**，填入相同的 Team name 和 AUD。設定該 hostname 的快取規則為 Bypass Cache。
3. 在 Ubuntu 的部署目錄複製 `.env.production.sample` 為 `.env.production`，填入 hostname、Team name 和 AUD。用權限 `0700` 的 `secrets/` 目錄保存 `database_url`、`cloudflared_token` 和從 Supabase 下載的公開憑證 `supabase_ca`。在 Compose bind mount 中，檔案需能被各自的非 root 容器程序讀取。以受限父目錄保護來源檔，或由伺服器的祕密管理機制掛載。正式環境預設關閉 AI 判讀。
4. 部署已驗證的 Git commit。GitHub Actions 負責檢查映像和 Compose 設定，Ubuntu 的部署由管理員透過 Tailscale 執行。保留上一個可部署 commit 與映像。正式站從登入到讀取資料驗證通過後再邀請使用者。

```bash
docker compose --env-file .env.production config --quiet
docker compose --env-file .env.production up -d --build
docker compose --env-file .env.production ps
```

## 驗收與維運

- 以匿名瀏覽器驗證展示頁可操作，正式網址與 API 會要求 Access 登入。以受邀和未受邀的身分各驗證一次。受邀帳號可在正式網址開啟 `/api/ready`，並用核准的測試資料驗證查詢及寫入。
- 在 Ubuntu 驗證 SSH 只從 Tailscale 可達，FastAPI 容器沒有發布主機埠。核對 Cloudflare Access 登入紀錄、Tunnel 狀態及 Supabase 資料庫用量。
- Supabase Free 的資料庫容量為 500 MB，低活動約一週可能暫停。定期以維護帳號對 `qaqc` 做加密的異地備份，實際還原到獨立環境驗證。搬移切換前保留 MariaDB 快照。切換後若正式站已產生新寫入，回復來源前先保存並核對新增資料。
- 公開 GitHub repo 歷史含先前追蹤的 SQL 備份和樣本資料。請確認其公開授權，正式匯出與資料庫密碼應保存在受控位置。

參考文件

- [GitHub Pages 概覽](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)
- [Cloudflare Tunnel 出站規則](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/tunnel-with-firewall/)
- [Cloudflare Access 保護應用程式](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)
- [Docker 與 Ubuntu 防火牆](https://docs.docker.com/engine/install/ubuntu/)
- [Supabase PostgreSQL 連線](https://supabase.com/docs/guides/database/connecting-to-postgres)
- [Supabase 免費方案暫停](https://supabase.com/docs/guides/platform/free-project-pausing)及[資料庫備份](https://supabase.com/docs/guides/platform/backups)
