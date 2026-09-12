# PJQAQC 資料庫說明（v3 分層式架構）

> MariaDB 10.11 / 資料庫 `PJQAQC`。建表語法見 [init_db.sql](init_db.sql)；
> 設計依據為 [database_design/README.md](../database_design/README.md)，並依本系統既有需求調整。

## 核心概念

整個模型的中心不是「檢驗項目」，而是 **assay（檢驗設定）**：

```
assay = 儀器 × 檢驗項目 × 檢體別
```

- `GLU/BLOOD` 與 `GLU/URINE` 是**兩筆**不同 assay
- `GLU/BLOOD` 在主機與備機上執行，也是**兩筆**不同 assay

每筆 assay 再透過三張 N:M 中介表，連到可用的試劑、品管液與校正液**產品**。

> **必須守住的約束**：品管判讀一律綁 `instrument`。Westgard 連續規則
> （2-2s、4-1s、10x）必須分機器各自成序列，主備機的品管**不可**混在一起判讀。

## 三層架構

| 層 | 回答的問題 | 資料表 |
|---|---|---|
| **A. 主檔／框架設定** | 系統「允許」什麼 | `lab_sections`、`instruments`、`specimen_types`、`test_items`、`instrument_assays`、三種 `*_products`、三張 `assay_*_requirements` |
| **B. 批號／庫存實體** | 現場「現在拿到哪一批」 | `reagent_lots`、`qc_lots`、`calibrator_lots`、`qc_target_values`、`instrument_reagent_loads` |
| **C. 交易／稽核** | 「實際發生了什麼」 | `qc_runs`、`qc_results`、`qc_result_reagents`、`calibration_events`、`calibration_event_assays`、`calibration_event_reagents` |

**分層的關鍵好處：換批號只新增 lot，不動設定。** 產品是穩定定義，批號是實體；
設定與關聯掛在產品/assay 上，因此換批永遠不會讓試劑或品管液關聯指錯。

---

## A. 主檔／框架設定層

### A1. `lab_sections` — 科別／組別
| 欄位 | 說明 |
|---|---|
| `section_id` CHAR(36) PK | UUID |
| `section_code` / `section_name` | 皆 UNIQUE。現有：生化免疫組(BIO)、血液組(HEM)、鏡檢組(URN)、血庫組(BB) |

### A2. `instruments` — 儀器實體
| 欄位 | 說明 |
|---|---|
| `instrument_id` CHAR(36) PK | UUID |
| `serial_number` UNIQUE | 儀器序號，全系統識別鍵 |
| `section_id` FK | 所屬組別 |
| `model_name` | 機型（如 XN-3000），主備機通常同機型 |
| `instrument_role` | `主機` / `備機` / `其他`（CHECK 約束）|
| `backup_of_instrument_id` FK→self | **備機指向其主機**，供「複製設定到備機」與配對顯示 |

### A3. `specimen_types` — 檢體別字典
`B`(BLOOD)、`U`(URINE)、`CSF`、`BF`(BODY FLUID)、`ST`(STOOL)

### A4. `test_items` — 檢驗項目字典（全院共用）
`item_code` UNIQUE。**不再綁儀器**——同一個 `CRE` 在多台儀器、多種檢體上共用同一筆字典。

> v2 用 `CRE-U` 這類後綴區分檢體；v3 改為 `item_code=CRE` + `specimen=URINE`。

### A5. `instrument_assays` — 檢驗設定（模型中心）
| 欄位 | 說明 |
|---|---|
| `assay_id` CHAR(36) PK | UUID |
| `instrument_id` / `test_item_id` / `specimen_type_id` | 三者組成 UNIQUE `uq_assay_route` |
| `result_unit` | 留空則採 `test_items.default_unit` |
| `decimal_places`、`method_name`、`instrument_test_code` | 儀器端設定 |
| `valid_from` / `valid_to` | 生效期間 |

另有 `UNIQUE (assay_id, instrument_id)`——供下游用**複合外鍵**保證「結果確實屬於該儀器」。

### A6. 三種產品主檔
`reagent_products`、`qc_products`、`calibrator_products`

三者結構相似：`product_code` UNIQUE、`product_name`、`manufacturer`、`catalog_number`。
**都不放批號，也不綁儀器**——靠 requirement 連到 assay，assay 才綁儀器。

### A7. 三張 N:M 中介表
| 表 | 關係 | 特有欄位 |
|---|---|---|
| `assay_reagent_requirements` | assay ↔ 試劑產品 | `reagent_role`（PRIMARY/AUXILIARY/DILUENT/WASH/OTHER）|
| `assay_qc_requirements` | assay ↔ 品管液產品 | `required`、`priority` |
| `assay_calibrator_requirements` | assay ↔ 校正液產品 | `required`、`priority` |

中介表不只表達共用關係，還保存角色與優先序。**換產品時改 mapping 即可，不必改任何歷史結果。**

---

## B. 批號／庫存實體層

### B1. `reagent_lots` — 試劑批號
標準欄位：`lot_number`（同產品內 UNIQUE）、`received_at`、`opened_at`、`expiry_date`、
`lot_status`（QUARANTINE/AVAILABLE/IN_USE/EXHAUSTED/EXPIRED/RECALLED）。

**本系統特有（參考設計未涵蓋，此處保留）：**
| 欄位 | 說明 |
|---|---|
| `parallel_test_done` / `parallel_test_date` | 入庫後是否已完成試劑平測 |
| `same_lot_as_previous` | 是否與上一批同批號 |
| `previous_reagent_lot_id` FK→self | 上一批，供批號延續性追溯 |

### B2. `qc_lots` — 品管液批號
`UNIQUE (qc_product_id, lot_number, level_code)`。
**同一 kit 的 Level 1/2/3 各一列**——濃度屬於批號，不屬於設定。
亦保留 `parallel_test_done` / `parallel_test_date`。

### B3. `calibrator_lots` — 校正液批號
含 `level_code` 與 `assigned_value_text`（原廠指定值）。

### B4. `qc_target_values` — 品管目標值（版本化）
每個 **assay × QC 批號** 的 mean/SD、允收區間與生效期間。

| 欄位 | 說明 |
|---|---|
| `target_source` | `MANUFACTURER`（平測前用原廠值）/ `LAB`（平測後的實驗室值）/ `PEER_GROUP` |
| `target_mean` / `target_sd` | SD 必須 > 0（CHECK）|
| `effective_from` / `effective_to` | `effective_to IS NULL` 表示目前生效中 |
| `current_slot` | 產生欄位；配合 `UNIQUE (assay_id, qc_lot_id, current_slot)`，**由 DB 保證同一 assay+批號只能有一筆生效中版本** |

> 平測的產出就在這裡：平測前建 `MANUFACTURER` 版本，平測完成後將舊版填入
> `effective_to`、另建一筆 `LAB` 版本。歷史判讀因此永遠可重現。

### B5. `instrument_reagent_loads` — 試劑上機
哪一批試劑、何時、裝到哪台儀器的哪個位置。
`UNIQUE (instrument_id, position_code, current_slot)` 保證**同一位置同時只有一批在線上**。

---

## C. 交易／稽核層

### C1. `qc_runs` — 一次品管執行（header）
一瓶多項目品管液跑一次，可產生多個項目的結果。含 `instrument_id`、`qc_lot_id`、`run_at`、`operator_id`。

### C2. `qc_results` — 單一項目的品管結果
| 欄位 | 說明 |
|---|---|
| `assay_id` | 哪一個檢驗設定 |
| `result_value` | 量測值 |
| `target_mean_snapshot` / `target_sd_snapshot` / `unit_snapshot` | **當時值快照** |
| `z_score` | 產生欄位：`(result − mean) / NULLIF(sd, 0)`，由 DB 自動算 |
| `result_status` | PASS / WARNING / FAIL / INVALID |
| `westgard_flags` JSON | 違反的規則，如 `["1-3s","2-2s"]` |

**為什麼要快照**：主檔日後變更（換批、重新平測）時，歷史判讀仍能重現「當時為何判為 Fail」——
這是醫療品質稽核的硬性要求。

三道複合外鍵保證資料一致：結果的 assay 屬於該 run 的儀器、QC 產品確實被該 assay 允許、
採用的目標值版本確實對應該 assay + 批號。

### C3. `qc_result_reagents`
該筆結果實際使用的試劑批號（可多筆，含角色）。

### C4. 校正三表
`calibration_events`（一次校正事件）→ `calibration_event_assays`（涵蓋哪些 assay 及各自 Pass/Fail）
→ `calibration_event_reagents`（各項目實際使用的試劑批號）。

---

## D. 讀取用 View

| View | 用途 |
|---|---|
| `v_assay_catalog` | assay 攤平：組別／儀器／項目／檢體／單位，一次查完 |
| `v_qc_result_detail` | 品管結果攤平：含儀器、項目、檢體、品管液產品與批號、z-score、判讀 |

> 查詢時**不要**一次展開三組 N:M（試劑×品管液×校正液），列數會相乘。
> API 建議分三個子查詢，或各自聚合成 JSON array。

---

## 常見問題排查

| 症狀 | 先查哪裡 |
|---|---|
| 新增 assay 報 FK 錯誤 | 儀器／項目／檢體三者是否都已建立 |
| 寫入 `qc_target_values` 被擋 | `assay_qc_requirements` 是否已允許該 QC 產品用於此 assay |
| 寫入 `qc_results` 被擋 | 該 assay 是否屬於 run 的儀器；`qc_target_id` 是否對應同一 assay+批號 |
| 換批後判讀整體偏移 | 新批是否已平測、`qc_target_values` 是否已建立 `LAB` 版本 |
| z-score 為 NULL | `target_sd_snapshot` 是否為 NULL 或 0 |
| 同一位置上機被擋 | 該位置是否有前一批未 `unloaded_at` |

## 刪除策略

主檔停用請用 `active = FALSE`；批號改 `lot_status`。
多數外鍵為 `ON DELETE RESTRICT`——**刻意讓誤刪在 DB 層直接失敗**。
僅中介表與明細表（requirements、event_assays 等）採 `CASCADE`，因為它們依附父資料而存在。

## Westgard 規則速查

| 規則 | 意義 | 結果 |
|------|------|------|
| `1-2s` | 單點超過 ±2SD | Warning（警告，非拒收）|
| `1-3s` | 單點超過 ±3SD | Fail |
| `2-2s` | 連續 2 點同方向超過 ±2SD | Fail |
| `R-4s` | 同批內兩點差距超過 4SD | Fail |
| `4-1s` | 連續 4 點同方向超過 ±1SD | Fail |
| `10x`  | 連續 10 點落在平均值同側 | Fail |
