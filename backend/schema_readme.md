# PJQAQC 資料庫說明 (schema readme)

> MariaDB 10.11 / 資料庫 `PJQAQC`。此檔取代原本的 `schema_readme` 資料表，供操作者快速查到每張表、每個欄位的意義與常見問題排查。
>
> **關聯流向**：`lab_group`（組別）→ `instruments`（儀器）→ `reagent_qc`（品管）→ `reagent`（試劑）→ `items`（項目）
> 所有主檔皆以 **UUID** 為主鍵。完整建表語法見 [init_db.sql](init_db.sql)。
>
> **關聯關係**
>
> | 關係 | 型態 | 實作方式 |
> |------|------|----------|
> | 儀器 → 試劑 | 1─N | `reagent.instrument_serial_number` |
> | 儀器 → 項目 | 1─N | `items.instrument_serial_number` |
> | 品管 ↔ 試劑 | N─M | 中介表 `qc_reagent_map` |
> | 試劑 ↔ 項目 | N─M | 中介表 `reagent_item_map` |
> | 試劑 ↔ 檢體 | N─M | 中介表 `reagent_specimen_map` |
> | 檢體 → 品管液 | 1─N | `reagent_qc.specimen_type_id` |
>
> 例：XN-3000 有 Fluorocell/Lysercell WNR、Fluorocell/Lysercell WDF 等多種試劑、3 個 level 的品管液，
> 以及 RBC/HGB/HCT/.../RET% 等多個項目；同一品管可涵蓋多種試劑，同一試劑可對應多個項目。
> 檢體例：m-ALB 試劑可驗 URINE 與 CSF（多對多）；Na 項目在 URINE 用 Liquichek Chemistry Urine Control，
> 在 BLOOD 用 PreciControl Clinchem Multi（同項目不同檢體 → 各自一筆品管液）。

---

## 1. `lab_group` — 組別主檔

集中管理實驗室組別；以 UUID 為主鍵，供其他表以 `group_id` 關聯。

| 欄位 | 型別 | 說明 | 排查建議 |
|------|------|------|----------|
| `group_id` | CHAR(36) PK | UUID 主鍵，`DEFAULT UUID()` 自動產生 | 請勿手動改此值；其他表以此關聯，改動會破壞關聯 |
| `group_name` | VARCHAR(50) UNIQUE | 組別名稱，如 生化免疫組 / 血液組 / 鏡檢組 / 血庫組 | 重複名稱會被 UNIQUE 擋下 |
| `group_code` | VARCHAR(20) | 組別代碼（選填） | — |
| `description` | VARCHAR(255) | 說明 | — |
| `active` | BOOLEAN | 是否啟用；停用組別建議設 FALSE 而非刪除，以保留歷史關聯 | — |
| `created_at` / `updated_at` | DATETIME | 建立 / 更新時間 | — |

> **常見問題**：若新增儀器時報 FK 錯誤，多半是 `group_id` 不存在或打錯，請先確認此表有對應組別。

---

## 2. `instruments` — 儀器主檔

組別改以 `group_id` 關聯 `lab_group`。

| 欄位 | 型別 | 說明 | 排查建議 |
|------|------|------|----------|
| `serial_number` | VARCHAR(100) PK | 儀器序號 S/N | 為所有品管紀錄的關聯鍵，請確保唯一且正確 |
| `instrument_name` | VARCHAR(200) | 儀器名稱 | — |
| `group_id` | CHAR(36) FK → `lab_group` | 儀器所屬組別 | 新增儀器前組別須先存在於 `lab_group` |
| `machine_role` | VARCHAR(20) | 主機 / 備機（主備機以 S/N 區分，品管分開判讀） | — |
| `active` | BOOLEAN | 是否啟用 | 查不到儀器時確認 `active=TRUE` |
| `created_at` / `updated_at` | DATETIME | 建立 / 更新時間 | — |

> **常見問題**：查不到儀器時確認 `active=TRUE`；分組錯誤請檢查 `group_id`。

---

## 3. `items` — 檢驗項目主檔

管理每台儀器上的所有檢驗項目（RBC / HGB / WBC ...）。一台儀器有多個項目（1─N）。

| 欄位 | 型別 | 說明 | 排查建議 |
|------|------|------|----------|
| `item_id` | CHAR(36) PK | UUID 主鍵 | — |
| `instrument_serial_number` | VARCHAR(100) FK → `instruments` | 此項目屬於哪台儀器 | — |
| `group_id` | CHAR(36) FK → `lab_group` | 所屬組別 | — |
| `item_code` | VARCHAR(50) | 項目代碼，如 RBC / HGB / NEUT% | 同儀器內 `item_code` 不可重複（`UNIQUE(instrument_serial_number, item_code)`） |
| `item_name` | VARCHAR(200) | 項目全名 | — |
| `unit` | VARCHAR(50) | 單位 | — |
| `sort_order` | INT | 顯示排序 | — |
| `active` | BOOLEAN | 是否啟用 | — |
| `remark` | TEXT | 備註 | — |
| `created_at` / `updated_at` | DATETIME | 建立 / 更新時間 | — |

> **常見問題**：同一項目（如 RBC）出現在多台儀器時，會在各儀器各自成一列，這是正常設計。

---

## 4. `specimen_type` — 檢體類別主檔

固定清單 lookup（可由 API 增補）。試劑可操作的檢體為多對多（`reagent_specimen_map`）；品管液各針對一種檢體（`reagent_qc.specimen_type_id`）。

| 欄位 | 型別 | 說明 | 排查建議 |
|------|------|------|----------|
| `specimen_type_id` | CHAR(36) PK | UUID 主鍵 | — |
| `code` | VARCHAR(20) UNIQUE | 檢體代碼，如 B / U / CSF / BF / ST | API 皆以 code 溝通；不存在的 code 會回 400 |
| `name` | VARCHAR(100) | 檢體名稱，如 BLOOD / URINE / CSF | — |
| `description` | VARCHAR(255) | 說明 | — |
| `active` | BOOLEAN | 是否啟用；停用建議設 FALSE 而非刪除 | — |
| `created_at` / `updated_at` | DATETIME | 建立 / 更新時間 | — |

> 已種入：`B`(BLOOD)、`U`(URINE)、`CSF`(CSF)、`BF`(BODY FLUID)、`ST`(STOOL)。

---

## 5. `reagent` — 試劑主檔

管理試劑入庫、平測與批號延續性。

| 欄位 | 型別 | 說明 | 排查建議 |
|------|------|------|----------|
| `reagent_id` | CHAR(36) PK | UUID 主鍵 | — |
| `group_id` | CHAR(36) FK → `lab_group` | 所屬組別 | — |
| `instrument_serial_number` | VARCHAR(100) FK → `instruments` | 此試劑用於哪台儀器 | — |
| `test_item` | VARCHAR(100) | 對應檢驗項目，如 GLU / WBC | 試劑無法連動品管時，確認 `test_item` 與儀器一致 |
| `reagent_name` | VARCHAR(200) | 試劑名稱 | — |
| `lot_number` | VARCHAR(100) | 試劑批號 | — |
| `manufacturer` | VARCHAR(200) | 廠商 | — |
| `in_stock` | BOOLEAN | 是否已入庫 | 未入庫（FALSE）的試劑不應被使用 |
| `in_stock_date` | DATE | 入庫日期 | — |
| `parallel_test_done` | BOOLEAN | 入庫後是否已完成試劑平行測試（平測） | 換新批號後若未平測即上線，品管可能整體偏移，請優先檢查此欄 |
| `parallel_test_date` | DATE | 試劑平測完成日期 | — |
| `same_lot_as_previous` | BOOLEAN | 是否與上一個批號為同一批號 | 同批號可沿用前批平測結果；不同批號通常需重新平測 |
| `previous_lot_number` | VARCHAR(100) | 上一個批號（供批號延續性追溯） | — |
| `expiry_date` | DATE | 效期 | — |
| `active` | BOOLEAN | 是否啟用 | — |
| `remark` | TEXT | 備註 | — |
| `created_at` / `updated_at` | DATETIME | 建立 / 更新時間 | — |

---

## 6. `reagent_qc` — 品管液主檔

品管液本身也是一種試劑，但具不同濃度（level），並追蹤平測後的新 standard mean / SD。
「一個品管管理哪些試劑」為多對多關係，見 `qc_reagent_map`。
同一檢驗項目、不同檢體使用不同品管液，故每筆各針對一種檢體（`specimen_type_id`）。

| 欄位 | 型別 | 說明 | 排查建議 |
|------|------|------|----------|
| `reagent_qc_id` | CHAR(36) PK | UUID 主鍵 | — |
| `group_id` | CHAR(36) FK → `lab_group` | 所屬組別 | — |
| `specimen_type_id` | CHAR(36) FK → `specimen_type` | 此品管液針對的檢體類別 | 同項目（如 Na）在 URINE 與 BLOOD 各自一筆品管液，屬正常設計 |
| `instrument_serial_number` | VARCHAR(100) FK → `instruments` | 對應儀器 | — |
| `test_item` | VARCHAR(100) | 檢驗項目 | — |
| `test_item_full_name` | VARCHAR(200) | 項目全名 | — |
| `qc_level` | VARCHAR(50) | 品管液濃度，如 Level 1/2/3（同項目不同濃度分開管理與判讀） | — |
| `qc_lot_number` | VARCHAR(100) | 品管液批號 | — |
| `unit` | VARCHAR(50) | 單位 | — |
| `manufacturer_mean` | DECIMAL | 原廠（或前批）均值，平測前採用 | — |
| `manufacturer_sd` | DECIMAL | 原廠（或前批）SD | — |
| `parallel_test_done` | BOOLEAN | 此品管液是否已完成平行測試 | 未平測（FALSE）時應沿用 `manufacturer_mean/sd` |
| `parallel_test_date` | DATE | 平行測試完成日期 | — |
| `new_standard_mean` | DECIMAL | 平行測試後建立的新 standard mean，平測後採用 | 平測完成卻仍為 NULL，代表新標準未建立，判讀會誤用舊值 |
| `new_standard_sd` | DECIMAL | 平行測試後建立的新 standard SD | — |
| `in_use` | BOOLEAN | 是否為目前使用中的品管液 | 同項目/濃度同時有多筆 `in_use=TRUE` 會造成判讀取值混淆，應僅保留一筆 |
| `active` | BOOLEAN | 是否啟用 | — |
| `remark` | TEXT | 備註 | — |
| `created_at` / `updated_at` | DATETIME | 建立 / 更新時間 | — |

> **常見問題**：z-score 異常且全面偏移時，先確認品管液是否換批、是否已平測、採用的 mean/SD 是否正確。

---

## 7. `qc_reagent_map` — 品管 ↔ 試劑 關聯（多對多）

一個品管（`reagent_qc`）可管理多種試劑；一個試劑亦可被多個品管涵蓋。

| 欄位 | 型別 | 說明 |
|------|------|------|
| `id` | BIGINT PK | 流水號 |
| `reagent_qc_id` | CHAR(36) FK → `reagent_qc` | 品管液 |
| `reagent_id` | CHAR(36) FK → `reagent` | 試劑 |
| `created_at` | DATETIME | 建立時間 |

> `UNIQUE(reagent_qc_id, reagent_id)` 防止重複關聯；刪除主檔時 `ON DELETE CASCADE` 自動清除關聯列。

---

## 8. `reagent_item_map` — 試劑 ↔ 項目 關聯（多對多）

一個試劑可用於多個檢驗項目；一個項目亦可由多個試劑產生。

| 欄位 | 型別 | 說明 |
|------|------|------|
| `id` | BIGINT PK | 流水號 |
| `reagent_id` | CHAR(36) FK → `reagent` | 試劑 |
| `item_id` | CHAR(36) FK → `items` | 項目 |
| `created_at` | DATETIME | 建立時間 |

> `UNIQUE(reagent_id, item_id)` 防止重複關聯；刪除主檔時 `ON DELETE CASCADE` 自動清除關聯列。

---

## 9. `reagent_specimen_map` — 試劑 ↔ 檢體 關聯（多對多）

同一種試劑可操作多種檢體，如 m-ALB 可驗 URINE 與 CSF。

| 欄位 | 型別 | 說明 |
|------|------|------|
| `id` | BIGINT PK | 流水號 |
| `reagent_id` | CHAR(36) FK → `reagent` | 試劑 |
| `specimen_type_id` | CHAR(36) FK → `specimen_type` | 檢體類別 |
| `created_at` | DATETIME | 建立時間 |

> `UNIQUE(reagent_id, specimen_type_id)` 防止重複關聯；刪除主檔時 `ON DELETE CASCADE` 自動清除關聯列。

---

## 10. `qc_records` — 品管紀錄

以 FK 連結組別 / 儀器 / 品管液，並保留關鍵欄位「快照」供稽核。

| 欄位 | 型別 | 說明 | 排查建議 |
|------|------|------|----------|
| `id` | BIGINT PK AUTO_INCREMENT | 流水號 | — |
| `reagent_qc_id` | CHAR(36) FK → `reagent_qc` | 此筆品管使用的品管液 | 為 NULL 表示未關聯品管液主檔，建議補上以利追溯 |
| `group_id` | CHAR(36) FK → `lab_group` | 所屬組別 | — |
| `instrument_serial_number` | VARCHAR(100) FK → `instruments` | 儀器 S/N | — |
| `instrument_name` | VARCHAR(200) | 儀器名稱（快照） | — |
| `test_item` | VARCHAR(100) | 檢驗項目（快照） | — |
| `test_item_full_name` | VARCHAR(200) | 項目全名（快照） | — |
| `qc_level` | VARCHAR(50) | 濃度（快照） | — |
| `qc_lot_number` | VARCHAR(100) | 品管液批號（快照） | — |
| `unit` | VARCHAR(50) | 單位（快照） | — |
| `lot_mean` | DECIMAL | 本次採用的均值（快照，刻意不隨主檔異動） | 與 `reagent_qc` 目前值不同屬正常（紀錄的是當時採用值） |
| `lot_standard_deviation` | DECIMAL | 本次採用的 SD（快照） | — |
| `acceptable_range_lower` / `_upper` | DECIMAL | 可接受範圍 | — |
| `qc_date` / `qc_time` | DATE / TIME | 品管日期 / 時間 | Dashboard 數字異常時，先用 `qc_date` + `instrument_serial_number` 縮小範圍 |
| `operator` | VARCHAR(100) | 操作者 | — |
| `qc_result_value` | DECIMAL | 品管結果值 | — |
| `z_score` | DECIMAL | (result − mean) / SD，判讀依據 | SD=0 或缺值時為 NULL；請檢查品管液 mean/SD 設定 |
| `qc_status` | VARCHAR(20) | Pass / Warning / Fail | — |
| `westgard_rule_violation` | TEXT | 違反的 Westgard 規則，如 1-3s、2-2s | Fail 但此欄為空（或反之）代表判讀邏輯與狀態不一致，請檢查後端 |
| `remark` | TEXT | 備註 | — |
| `created_at` | DATETIME | 建立時間 | — |

---

## Westgard 規則速查

| 規則 | 意義 | 結果 |
|------|------|------|
| `1-2s` | 單點超過 ±2SD | Warning（警告，非拒收）|
| `1-3s` | 單點超過 ±3SD | Fail |
| `2-2s` | 連續 2 點同方向超過 ±2SD | Fail |
| `R-4s` | 同批內兩點差距超過 4SD | Fail |
| `4-1s` | 連續 4 點同方向超過 ±1SD | Fail |
| `10x`  | 連續 10 點落在平均值同側 | Fail |
