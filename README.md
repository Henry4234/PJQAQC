# QAQC 品管管理系統

實驗室品質管制（Laboratory Quality Control）管理系統，含 Westgard 多規則自動判讀。

- **前端**：原生 HTML / CSS / JavaScript 網頁（儀表板、紀錄查詢、新增品管）
- **後端**：Python FastAPI（API + 提供前端靜態檔）
- **資料庫**：Supabase（PostgreSQL），資料表 `qc_records`

## 架構

```
瀏覽器 (frontend/)  ──fetch /api/*──►  FastAPI (backend/main.py)  ──►  Supabase
```

## 目錄結構

```
PJQAQC/
├── backend/
│   ├── main.py            # FastAPI 主程式（API + 靜態前端）
│   ├── westgard.py        # Westgard 多規則判讀邏輯
│   ├── westgard_guide.md  # AI 判讀用的實驗室規則說明
│   ├── pyproject.toml     # uv 依賴定義
│   ├── requirements.txt   # pip 相容依賴清單
│   └── .env.sample        # 環境變數範本（複製為 .env 後填值）
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
cp .env.sample .env        # 接著編輯 .env 填入 SUPABASE_URL / SUPABASE_KEY / ANTHROPIC_API_KEY

# 2. 用 uv 建立虛擬環境並安裝依賴（比 venv + pip 快很多）
uv sync

# 3. 啟動伺服器
uv run uvicorn main:app --host 127.0.0.1 --port 8000 --reload
```

開啟瀏覽器： http://127.0.0.1:8000

> 若偏好傳統 pip：`uv venv && uv pip install -r requirements.txt`，或 `python3 -m venv venv && ./venv/bin/pip install -r requirements.txt`。

## API 端點

| 方法 | 路徑 | 說明 |
|------|------|------|
| GET  | `/api/dashboard?target_date=YYYY-MM-DD` | 儀表板統計（預設今天）|
| GET  | `/api/records?qc_date=&test_item=&limit=` | 品管紀錄查詢 |
| POST | `/api/records` | 新增品管（自動算 Z-score 與 Westgard 判讀）|
| GET  | `/api/test-items?instrument_serial_number=` | 某儀器有紀錄的檢驗項目 |
| POST | `/api/ai-interpret` | AI 品管判讀（連線 Claude，依 Westgard 規則分析）|
| GET  | `/api/health` | 健康檢查 |

## AI 判讀功能

「AI 判讀」分頁可選擇組別、儀器、日期區間、檢驗項目，按下「AI 判讀」後：

1. 後端從 Supabase 提取所選品管資料
2. 以 [backend/westgard_guide.md](backend/westgard_guide.md)（實驗室規則說明，含 1-3s / 2-2s 等違規時的試劑、隨機誤差、人員等可能成因）作為系統提示
3. 連線 Anthropic Claude（預設 `claude-opus-4-8`，adaptive thinking）做專業判讀並回傳矯正建議

**需在 [backend/.env](backend/.env) 設定 `ANTHROPIC_API_KEY`（格式 `sk-ant-...`）後重啟伺服器。** 可用 `AI_MODEL` 覆寫模型。未設定金鑰時，此功能會回傳明確的設定提示。

## Dashboard 指標

- 今日品管次數、Pass / Warning / Fail 數量
- 違反 Westgard 規則次數與明細
- 通過率、各儀器品管狀況、各規則違規次數長條圖

## Westgard 規則

`westgard.py` 實作：`1-2s`（警告）、`1-3s`、`2-2s`、`R-4s`、`4-1s`、`10x`。
新增品管時，後端會撈同儀器 / 項目 / 濃度的歷史 z-score 序列做連續型規則（2-2s、4-1s、10x 等）判讀。

## 資料庫 Schema (`qc_records`)

含儀器、科別、檢驗項目、品管濃度 / 批號、結果值、批號均值 / SD、可接受範圍、
z-score、品管狀態（Pass / Warning / Fail）、Westgard 違規規則、備註等欄位。

> 注意：目前 Supabase RLS 政策為 demo 用途開放 anon 全權限，正式上線前請收緊。
