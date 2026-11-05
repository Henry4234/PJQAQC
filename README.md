# QAQC 品管管理系統

實驗室品質管制（Laboratory Quality Control）管理系統，含 Westgard 多規則自動判讀。

- [匿名展示](https://henry4234.github.io/PJQAQC/) 使用合成資料，可查看品管趨勢與判讀。
- [Ubuntu 與 Supabase 上線手冊](DEPLOYMENT.md) 說明正式站部署、搬移與驗收。

- **前端**：原生 HTML / CSS / JavaScript 網頁（儀表板、紀錄查詢、新增品管）
- **後端**：Python FastAPI（API + 提供前端靜態檔）
- **資料庫**：本機可用 MariaDB，正式環境支援 Supabase PostgreSQL v3。

## 架構

```
瀏覽器 (frontend/)  ──fetch /api/*──►  FastAPI (backend/main.py)  ──►  MySQL (NAS)
```

## 目錄結構

```
PJQAQC/
├── backend/
│   ├── main.py            # FastAPI 主程式（API + 靜態前端）
│   ├── database.py        # MySQL 連線模組
│   ├── ai_interpret.py    # AI 品管判讀（品管資料 JSON、Claude / OpenAI）
│   ├── westgard.py        # Westgard 多規則判讀邏輯
│   ├── westgard_guide.md  # AI 判讀的系統提示詞（規則、判讀原則、輸出格式）
│   ├── init_db.sql        # MySQL 資料表建立腳本
│   ├── pyproject.toml     # uv 依賴定義
│   ├── requirements.txt   # pip 相容依賴清單
│   ├── .env.sample        # 環境變數範本（複製為 .env 後填值）
│   └── .env               # 本機設定與金鑰（自行建立，不會進入 Git）
├── frontend/
│   ├── index.html
│   ├── style.css
│   └── app.js
└── dummy_qcrecord.json    # 原始參考資料
```

## 啟動方式（使用 [uv](https://docs.astral.sh/uv/)）

```bash
cd backend

# 1. 建立環境變數檔並填入金鑰
cp .env.sample .env        # 接著編輯 .env 填入 MySQL 連線資訊；AI 金鑰見「API 金鑰設定」

# 2. 用 uv 建立虛擬環境並安裝依賴（比 venv + pip 快很多）
uv sync

# 3. 初始化 MySQL 資料表（首次）
mysql -h 192.168.0.111 -u PJQAQC -p PJQAQC < init_db.sql

# 4. 啟動伺服器
uv run uvicorn main:app --host 127.0.0.1 --port 8000 --reload
```

開啟瀏覽器： http://127.0.0.1:8000

> 若偏好傳統 pip：`uv venv && uv pip install -r requirements.txt`，或 `python3 -m venv venv && ./venv/bin/pip install -r requirements.txt`。

## API 端點

| 方法 | 路徑 | 說明 |
|------|------|------|
| GET  | `/api/instruments` | 儀器主檔（依組別分群）|
| GET  | `/api/dashboard?target_date=YYYY-MM-DD` | 儀表板統計（預設今天）|
| GET  | `/api/records?qc_date=&test_item=&limit=` | 品管紀錄查詢 |
| POST | `/api/records` | 新增品管（自動算 Z-score 與 Westgard 判讀）|
| GET  | `/api/test-items?instrument_serial_number=` | 某儀器有紀錄的檢驗項目 |
| GET  | `/api/ai-providers` | 可用的 AI 供應商與模型（不含金鑰）|
| GET  | `/api/ai-qc-data?date_from=&date_to=&section_name=&instrument_serial_number=&item_code=` | 送給 AI 判讀的品管原始資料（JSON，`date_from` 必填）|
| POST | `/api/ai-interpret` | AI 品管判讀（Claude 或 OpenAI，依 Westgard 規則分析）|
| GET  | `/api/health` | 健康檢查 |

## AI 判讀功能

「AI 判讀」分頁依序選擇組別、儀器、項目（次級選單，隨組別與儀器連動）、日期區間與 AI 模型，按下「AI 判讀」後：

1. 後端依條件從資料庫抓取品管結果，組成 JSON（與 `GET /api/ai-qc-data` 回傳內容相同）。
2. 若查無資料（`summary.record_count` 為 0），就不呼叫 AI，也不產生費用：`POST /api/ai-interpret` 回傳 404，`detail.code` 為 `NO_QC_DATA`，頁面以彈窗告知「所選的項目目前無資料，無法判讀」。
3. 有資料時，以 [backend/westgard_guide.md](backend/westgard_guide.md) 作為系統提示詞，連同 JSON 一起送給所選模型。
4. 頁面顯示判讀結論、異常判讀、趨勢、建議措施與資料限制。

預設模型為 Claude `claude-opus-5-5` 與 OpenAI `gpt-6.1-sol`，可在 `backend/.env` 以 `AI_MODEL`、`OPENAI_MODEL` 覆寫。

送給 AI 的 JSON 依 Westgard 序列（儀器 × 項目 × 檢體 × 品管液批號）分組，結果由舊到新。單次最多 1000 筆，超過時保留最新資料，並在 `summary.truncated` 與頁面上提示。

```json
{
  "schema_version": "pjqaqc.qc-ai-input.v1",
  "query": { "section_name": null, "instrument_serial_number": "SN-1", "item_code": "GLU", "date_from": "2026-10-01", "date_to": null },
  "summary": {
    "record_count": 2, "series_count": 1, "truncated": false, "max_records": 1000,
    "first_run_at": "2026-10-01T08:00:00", "last_run_at": "2026-10-02T08:00:00",
    "status_counts": { "PASS": 1, "WARNING": 0, "FAIL": 1, "INVALID": 0 },
    "rule_counts": { "1-3s": 1 }
  },
  "series": [{
    "section_name": "生化組", "serial_number": "SN-1", "instrument_name": "Demo Analyzer", "instrument_role": "PRIMARY",
    "item_code": "GLU", "item_name": "Glucose", "specimen_code": "S", "specimen_name": "Serum",
    "qc_product_name": "Demo QC", "qc_lot_number": "LOT-A", "qc_level": "L1", "unit": "mg/dL",
    "results": [
      { "run_at": "2026-10-01T08:00:00", "value": 100.2, "mean": 100.0, "sd": 2.0, "z": 0.1, "status": "PASS", "westgard_flags": [], "note": null },
      { "run_at": "2026-10-02T08:00:00", "value": 107.0, "mean": 100.0, "sd": 2.0, "z": 3.5, "status": "FAIL", "westgard_flags": ["1-3s"], "note": null }
    ]
  }]
}
```

按下判讀時，上述資料會傳送到所選的 AI 供應商。操作人員與覆核人員欄位不會傳送；備註（`note`）會傳送，請勿在備註中填寫病人資料。正式環境預設關閉此功能，須明確設定 `ENABLE_AI_INTERPRET=1` 才會啟用。

## API 金鑰設定

**協作者請使用自己的 API 金鑰。** 本專案不提供共用金鑰，呼叫費用會計入金鑰所屬的帳戶。

1. 到各平台申請金鑰，至少一把即可使用 AI 判讀：
   - Claude：[Claude Console](https://console.anthropic.com/settings/keys)
   - OpenAI：[OpenAI Platform](https://platform.openai.com/api-keys)
2. 把金鑰放在 **`backend/.env`**（由 `backend/.env.sample` 複製），這是唯一該放金鑰的地方：

   ```bash
   ANTHROPIC_API_KEY=sk-ant-...
   OPENAI_API_KEY=sk-...
   ```

3. 重啟伺服器。未設定金鑰的供應商會在選單中停用，其他功能不受影響。

金鑰不可寫進程式碼、前端、測試、Issue 或 PR。`backend/.env` 已被 `.gitignore` 排除，提交前可用以下指令確認：

```bash
git check-ignore -v backend/.env      # 應顯示符合 .gitignore 的規則
git ls-files | grep -E '\.env'        # 只應列出 .env.sample 與 .env.production.sample
```

不想使用金鑰時也能開發：`GET /api/ai-qc-data` 不會呼叫 AI，自動化測試也不需要金鑰、資料庫或網路，且不會產生費用：

```bash
cd backend
uv run python test_ai_interpret.py
```

**如果金鑰外洩**（包含曾被 commit，即使之後已刪除），請立刻到該平台撤銷並重新產生。本 repo 是公開的，只清除 Git 歷史並不足夠。

## Dashboard 指標

- 今日品管次數、Pass / Warning / Fail 數量
- 違反 Westgard 規則次數與明細
- 通過率、各儀器品管狀況、各規則違規次數長條圖

## Westgard 規則

`westgard.py` 實作：`1-2s`（警告）、`1-3s`、`2-2s`、`R-4s`、`4-1s`、`10x`。
新增品管時，後端會撈同儀器 / 項目 / 濃度的歷史 z-score 序列做連續型規則（2-2s、4-1s、10x 等）判讀。

## 資料庫 Schema

關聯式架構：`lab_group`（組別）→ `instruments`（儀器）→ `reagent` / `reagent_qc`（試劑 / 品管液）→ `qc_records`（品管紀錄），主檔皆以 UUID 為主鍵。

- 建表語法：[backend/init_db.sql](backend/init_db.sql)
- 逐表 / 逐欄說明與問題排查：[backend/schema_readme.md](backend/schema_readme.md)
