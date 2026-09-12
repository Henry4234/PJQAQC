-- ============================================================================
-- PJQAQC 檢驗科品管資料庫（v3 分層式重構）
-- 目標環境：MariaDB 10.11（NAS 192.168.0.111）／資料庫 PJQAQC
--
-- 設計依據：database_design/README.md 的三層式架構，並依既有系統調整：
--   * 主鍵沿用 CHAR(36) UUID（非參考設計的 BIGINT）
--   * collation 用 utf8mb4_unicode_ci（MariaDB 無 MySQL 8 的 utf8mb4_0900_ai_ci）
--   * 機器角色沿用中文「主機 / 備機」
--   * 保留參考設計未涵蓋、但本系統既有的「平行測試（平測）」欄位
--   * 新增 instruments.backup_of_instrument_id 記錄主備機配對，供「複製設定到備機」使用
--
-- 三層：
--   A. 主檔／框架設定層 — 系統「允許」什麼
--   B. 批號／庫存實體層 — 現場「現在拿到哪一批」
--   C. 交易／稽核層     — 「實際發生了什麼」
--
-- 核心概念：assay（檢驗設定）= 儀器 × 檢驗項目 × 檢體別
--   GLU/BLOOD 與 GLU/URINE 是兩筆；GLU/BLOOD 在主機與備機上也是兩筆。
--   品管判讀必須分機器各自成序列（Westgard 2-2s/4-1s/10x），故結果一律綁 instrument。
--
-- 警告：本腳本會先 DROP 既有物件，執行前請確認已備份。
-- ============================================================================

SET NAMES utf8mb4;

DROP VIEW IF EXISTS v_qc_result_detail;
DROP VIEW IF EXISTS v_assay_catalog;

SET FOREIGN_KEY_CHECKS = 0;
-- C. 交易層
DROP TABLE IF EXISTS calibration_event_reagents;
DROP TABLE IF EXISTS calibration_event_assays;
DROP TABLE IF EXISTS calibration_events;
DROP TABLE IF EXISTS qc_result_reagents;
DROP TABLE IF EXISTS qc_results;
DROP TABLE IF EXISTS qc_runs;
-- B. 批號層
DROP TABLE IF EXISTS instrument_reagent_loads;
DROP TABLE IF EXISTS qc_target_values;
DROP TABLE IF EXISTS calibrator_lots;
DROP TABLE IF EXISTS qc_lots;
DROP TABLE IF EXISTS reagent_lots;
-- A. 設定層
DROP TABLE IF EXISTS assay_calibrator_requirements;
DROP TABLE IF EXISTS assay_qc_requirements;
DROP TABLE IF EXISTS assay_reagent_requirements;
DROP TABLE IF EXISTS calibrator_products;
DROP TABLE IF EXISTS qc_products;
DROP TABLE IF EXISTS reagent_products;
DROP TABLE IF EXISTS instrument_assays;
DROP TABLE IF EXISTS test_items;
DROP TABLE IF EXISTS specimen_types;
DROP TABLE IF EXISTS instruments;
DROP TABLE IF EXISTS lab_sections;
-- v2 舊表（重構後不再使用）
DROP TABLE IF EXISTS reagent_qc_lot;
DROP TABLE IF EXISTS qc_reagent_map;
DROP TABLE IF EXISTS reagent_item_map;
DROP TABLE IF EXISTS reagent_specimen_map;
DROP TABLE IF EXISTS reagent_qc;
DROP TABLE IF EXISTS qc_records;
DROP TABLE IF EXISTS reagent;
DROP TABLE IF EXISTS items;
DROP TABLE IF EXISTS specimen_type;
DROP TABLE IF EXISTS lab_group;
SET FOREIGN_KEY_CHECKS = 1;


-- ==========================================================================
-- A. 主檔／框架設定層
-- ==========================================================================

-- A1. 科別 / 組別
CREATE TABLE lab_sections (
    section_id   CHAR(36)     NOT NULL DEFAULT UUID() PRIMARY KEY,
    section_code VARCHAR(30)  NOT NULL,
    section_name VARCHAR(100) NOT NULL,
    description  VARCHAR(500) NULL,
    active       BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at   DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at   DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
                              ON UPDATE CURRENT_TIMESTAMP(6),
    UNIQUE KEY uq_lab_sections_code (section_code),
    UNIQUE KEY uq_lab_sections_name (section_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- A2. 儀器實體（以序號唯一識別）
CREATE TABLE instruments (
    instrument_id   CHAR(36)     NOT NULL DEFAULT UUID() PRIMARY KEY,
    section_id      CHAR(36)     NOT NULL,
    serial_number   VARCHAR(100) NOT NULL,
    instrument_name VARCHAR(150) NOT NULL,
    manufacturer    VARCHAR(150) NULL,
    model_name      VARCHAR(100) NULL COMMENT '機型，如 XN-3000；主備機通常同機型',
    instrument_role VARCHAR(20)  NOT NULL DEFAULT '主機' COMMENT '主機 / 備機 / 其他',
    backup_of_instrument_id CHAR(36) NULL
                    COMMENT '若為備機，指向其對應主機；供「複製設定到備機」與配對顯示',
    active          BOOLEAN      NOT NULL DEFAULT TRUE,
    installed_at    DATE         NULL,
    retired_at      DATE         NULL,
    created_at      DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at      DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
                                 ON UPDATE CURRENT_TIMESTAMP(6),
    UNIQUE KEY uq_instruments_serial (serial_number),
    KEY idx_instruments_section_active (section_id, active),
    KEY idx_instruments_backup_of (backup_of_instrument_id),
    CONSTRAINT chk_instruments_role
        CHECK (instrument_role IN ('主機', '備機', '其他')),
    CONSTRAINT chk_instruments_dates
        CHECK (retired_at IS NULL OR installed_at IS NULL OR retired_at >= installed_at),
    CONSTRAINT fk_instruments_section
        FOREIGN KEY (section_id) REFERENCES lab_sections(section_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_instruments_backup_of
        FOREIGN KEY (backup_of_instrument_id) REFERENCES instruments(instrument_id)
        ON UPDATE RESTRICT ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- A3. 檢體別字典
CREATE TABLE specimen_types (
    specimen_type_id CHAR(36)     NOT NULL DEFAULT UUID() PRIMARY KEY,
    specimen_code    VARCHAR(30)  NOT NULL COMMENT '如 B / U / CSF',
    specimen_name    VARCHAR(100) NOT NULL COMMENT '如 BLOOD / URINE / CSF',
    description      VARCHAR(500) NULL,
    active           BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at       DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at       DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
                                  ON UPDATE CURRENT_TIMESTAMP(6),
    UNIQUE KEY uq_specimen_types_code (specimen_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- A4. 檢驗項目字典（全院共用；不再綁儀器）
CREATE TABLE test_items (
    test_item_id CHAR(36)     NOT NULL DEFAULT UUID() PRIMARY KEY,
    item_code    VARCHAR(50)  NOT NULL COMMENT '如 GLU / Na / WBC / NEUT%',
    item_name    VARCHAR(150) NULL,
    loinc_code   VARCHAR(30)  NULL,
    default_unit VARCHAR(50)  NULL,
    description  VARCHAR(500) NULL,
    active       BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at   DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at   DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
                              ON UPDATE CURRENT_TIMESTAMP(6),
    UNIQUE KEY uq_test_items_code (item_code),
    KEY idx_test_items_name (item_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- A5. 檢驗設定（整個模型的中心）= 儀器 × 項目 × 檢體
CREATE TABLE instrument_assays (
    assay_id             CHAR(36)     NOT NULL DEFAULT UUID() PRIMARY KEY,
    instrument_id        CHAR(36)     NOT NULL,
    test_item_id         CHAR(36)     NOT NULL,
    specimen_type_id     CHAR(36)     NOT NULL,
    instrument_test_code VARCHAR(80)  NULL COMMENT '儀器端的項目代碼',
    method_name          VARCHAR(150) NULL,
    result_unit          VARCHAR(50)  NULL COMMENT '留空則採 test_items.default_unit',
    decimal_places       TINYINT UNSIGNED NOT NULL DEFAULT 2,
    active               BOOLEAN      NOT NULL DEFAULT TRUE,
    valid_from           DATE         NULL,
    valid_to             DATE         NULL,
    created_at           DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at           DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
                                      ON UPDATE CURRENT_TIMESTAMP(6),
    UNIQUE KEY uq_assay_route (instrument_id, test_item_id, specimen_type_id),
    -- 供下游以複合 FK 確保「結果確實屬於該儀器」
    UNIQUE KEY uq_assay_id_instrument (assay_id, instrument_id),
    KEY idx_assays_item_specimen (test_item_id, specimen_type_id, active),
    KEY idx_assays_specimen_item (specimen_type_id, test_item_id, active),
    CONSTRAINT chk_assays_decimal_places CHECK (decimal_places <= 8),
    CONSTRAINT chk_assays_dates
        CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from),
    CONSTRAINT fk_assays_instrument
        FOREIGN KEY (instrument_id) REFERENCES instruments(instrument_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_assays_test_item
        FOREIGN KEY (test_item_id) REFERENCES test_items(test_item_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_assays_specimen
        FOREIGN KEY (specimen_type_id) REFERENCES specimen_types(specimen_type_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- A6. 三種產品主檔（皆不放批號；不綁儀器，靠 requirement 連到 assay）
CREATE TABLE reagent_products (
    reagent_product_id CHAR(36)     NOT NULL DEFAULT UUID() PRIMARY KEY,
    product_code       VARCHAR(60)  NOT NULL,
    product_name       VARCHAR(180) NOT NULL,
    manufacturer       VARCHAR(150) NULL,
    catalog_number     VARCHAR(100) NULL,
    storage_condition  VARCHAR(255) NULL,
    active             BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at         DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at         DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
                                    ON UPDATE CURRENT_TIMESTAMP(6),
    UNIQUE KEY uq_reagent_products_code (product_code),
    KEY idx_reagent_products_name (product_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE qc_products (
    qc_product_id      CHAR(36)     NOT NULL DEFAULT UUID() PRIMARY KEY,
    product_code       VARCHAR(60)  NOT NULL,
    product_name       VARCHAR(180) NOT NULL,
    manufacturer       VARCHAR(150) NULL,
    catalog_number     VARCHAR(100) NULL,
    matrix_description VARCHAR(255) NULL,
    storage_condition  VARCHAR(255) NULL,
    active             BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at         DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at         DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
                                    ON UPDATE CURRENT_TIMESTAMP(6),
    UNIQUE KEY uq_qc_products_code (product_code),
    KEY idx_qc_products_name (product_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE calibrator_products (
    calibrator_product_id CHAR(36)     NOT NULL DEFAULT UUID() PRIMARY KEY,
    product_code          VARCHAR(60)  NOT NULL,
    product_name          VARCHAR(180) NOT NULL,
    manufacturer          VARCHAR(150) NULL,
    catalog_number        VARCHAR(100) NULL,
    matrix_description    VARCHAR(255) NULL,
    storage_condition     VARCHAR(255) NULL,
    active                BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at            DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at            DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
                                       ON UPDATE CURRENT_TIMESTAMP(6),
    UNIQUE KEY uq_calibrator_products_code (product_code),
    KEY idx_calibrator_products_name (product_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- A7. 三張 N:M mapping（assay ↔ 產品）
-- 一個 assay 可能需要多支試劑（主試劑 / 稀釋液 / 清洗液），同一支試劑也可服務多個 assay
CREATE TABLE assay_reagent_requirements (
    assay_id           CHAR(36)     NOT NULL,
    reagent_product_id CHAR(36)     NOT NULL,
    reagent_role       VARCHAR(30)  NOT NULL DEFAULT 'PRIMARY',
    required           BOOLEAN      NOT NULL DEFAULT TRUE,
    priority           SMALLINT UNSIGNED NOT NULL DEFAULT 1,
    note               VARCHAR(500) NULL,
    created_at         DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (assay_id, reagent_product_id, reagent_role),
    KEY idx_arr_product_assay (reagent_product_id, assay_id),
    CONSTRAINT chk_arr_role
        CHECK (reagent_role IN ('PRIMARY', 'AUXILIARY', 'DILUENT', 'WASH', 'OTHER')),
    CONSTRAINT fk_arr_assay
        FOREIGN KEY (assay_id) REFERENCES instrument_assays(assay_id)
        ON UPDATE RESTRICT ON DELETE CASCADE,
    CONSTRAINT fk_arr_product
        FOREIGN KEY (reagent_product_id) REFERENCES reagent_products(reagent_product_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 一瓶多項目品管液可涵蓋多個 assay
CREATE TABLE assay_qc_requirements (
    assay_id      CHAR(36)     NOT NULL,
    qc_product_id CHAR(36)     NOT NULL,
    required      BOOLEAN      NOT NULL DEFAULT TRUE,
    priority      SMALLINT UNSIGNED NOT NULL DEFAULT 1,
    note          VARCHAR(500) NULL,
    created_at    DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (assay_id, qc_product_id),
    KEY idx_aqr_product_assay (qc_product_id, assay_id),
    CONSTRAINT fk_aqr_assay
        FOREIGN KEY (assay_id) REFERENCES instrument_assays(assay_id)
        ON UPDATE RESTRICT ON DELETE CASCADE,
    CONSTRAINT fk_aqr_product
        FOREIGN KEY (qc_product_id) REFERENCES qc_products(qc_product_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE assay_calibrator_requirements (
    assay_id              CHAR(36)     NOT NULL,
    calibrator_product_id CHAR(36)     NOT NULL,
    required              BOOLEAN      NOT NULL DEFAULT TRUE,
    priority              SMALLINT UNSIGNED NOT NULL DEFAULT 1,
    note                  VARCHAR(500) NULL,
    created_at            DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (assay_id, calibrator_product_id),
    KEY idx_acr_product_assay (calibrator_product_id, assay_id),
    CONSTRAINT fk_acr_assay
        FOREIGN KEY (assay_id) REFERENCES instrument_assays(assay_id)
        ON UPDATE RESTRICT ON DELETE CASCADE,
    CONSTRAINT fk_acr_product
        FOREIGN KEY (calibrator_product_id)
        REFERENCES calibrator_products(calibrator_product_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ==========================================================================
-- B. 批號／庫存實體層
--    換批號只新增 lot，不新建 product；設定與關聯完全不受影響。
-- ==========================================================================

-- B1. 試劑批號（含本系統既有的「入庫 / 平測 / 批號延續性」欄位）
CREATE TABLE reagent_lots (
    reagent_lot_id     CHAR(36)     NOT NULL DEFAULT UUID() PRIMARY KEY,
    reagent_product_id CHAR(36)     NOT NULL,
    lot_number         VARCHAR(100) NOT NULL,
    received_at        DATE         NULL COMMENT '入庫日',
    opened_at          DATETIME(6)  NULL COMMENT '開封時間',
    expiry_date        DATE         NULL,
    quantity_received  DECIMAL(14,3) NULL,
    quantity_unit      VARCHAR(30)  NULL,
    lot_status         VARCHAR(20)  NOT NULL DEFAULT 'AVAILABLE',
    -- 既有系統的平測流程（參考設計未涵蓋，此處保留）
    parallel_test_done BOOLEAN      NOT NULL DEFAULT FALSE COMMENT '入庫後是否已完成試劑平測',
    parallel_test_date DATE         NULL,
    same_lot_as_previous BOOLEAN    NOT NULL DEFAULT FALSE COMMENT '是否與上一批為同一批號',
    previous_reagent_lot_id CHAR(36) NULL COMMENT '上一批，供批號延續性追溯',
    certificate_uri    VARCHAR(500) NULL,
    note               VARCHAR(500) NULL,
    created_at         DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at         DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
                                    ON UPDATE CURRENT_TIMESTAMP(6),
    UNIQUE KEY uq_reagent_lot (reagent_product_id, lot_number),
    UNIQUE KEY uq_reagent_lot_product (reagent_lot_id, reagent_product_id),
    KEY idx_reagent_lots_expiry_status (expiry_date, lot_status),
    KEY idx_reagent_lots_prev (previous_reagent_lot_id),
    CONSTRAINT chk_reagent_lots_status
        CHECK (lot_status IN ('QUARANTINE','AVAILABLE','IN_USE','EXHAUSTED','EXPIRED','RECALLED')),
    CONSTRAINT chk_reagent_lots_dates
        CHECK (expiry_date IS NULL OR received_at IS NULL OR expiry_date >= received_at),
    CONSTRAINT fk_reagent_lots_product
        FOREIGN KEY (reagent_product_id) REFERENCES reagent_products(reagent_product_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_reagent_lots_prev
        FOREIGN KEY (previous_reagent_lot_id) REFERENCES reagent_lots(reagent_lot_id)
        ON UPDATE RESTRICT ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- B2. 品管液批號：同一 kit 的 Level 1/2/3 各一列
CREATE TABLE qc_lots (
    qc_lot_id          CHAR(36)     NOT NULL DEFAULT UUID() PRIMARY KEY,
    qc_product_id      CHAR(36)     NOT NULL,
    lot_number         VARCHAR(100) NOT NULL,
    level_code         VARCHAR(30)  NOT NULL COMMENT '如 Level 1 / Ci-Trol 1',
    received_at        DATE         NULL,
    opened_at          DATETIME(6)  NULL,
    expiry_date        DATE         NULL,
    lot_status         VARCHAR(20)  NOT NULL DEFAULT 'AVAILABLE',
    -- 平測狀態；平測後的實際 mean/SD 以 qc_target_values(target_source='LAB') 表示
    parallel_test_done BOOLEAN      NOT NULL DEFAULT FALSE COMMENT '此批是否已完成平行測試',
    parallel_test_date DATE         NULL,
    certificate_uri    VARCHAR(500) NULL,
    note               VARCHAR(500) NULL,
    created_at         DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at         DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
                                    ON UPDATE CURRENT_TIMESTAMP(6),
    UNIQUE KEY uq_qc_lot_level (qc_product_id, lot_number, level_code),
    UNIQUE KEY uq_qc_lot_product (qc_lot_id, qc_product_id),
    KEY idx_qc_lots_expiry_status (expiry_date, lot_status),
    CONSTRAINT chk_qc_lots_status
        CHECK (lot_status IN ('QUARANTINE','AVAILABLE','IN_USE','EXHAUSTED','EXPIRED','RECALLED')),
    CONSTRAINT chk_qc_lots_dates
        CHECK (expiry_date IS NULL OR received_at IS NULL OR expiry_date >= received_at),
    CONSTRAINT fk_qc_lots_product
        FOREIGN KEY (qc_product_id) REFERENCES qc_products(qc_product_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- B3. 校正液批號
CREATE TABLE calibrator_lots (
    calibrator_lot_id     CHAR(36)     NOT NULL DEFAULT UUID() PRIMARY KEY,
    calibrator_product_id CHAR(36)     NOT NULL,
    lot_number            VARCHAR(100) NOT NULL,
    level_code            VARCHAR(30)  NOT NULL DEFAULT 'DEFAULT',
    assigned_value_text   VARCHAR(500) NULL COMMENT '原廠指定值（多項目時以文字或 JSON 記錄）',
    received_at           DATE         NULL,
    opened_at             DATETIME(6)  NULL,
    expiry_date           DATE         NULL,
    lot_status            VARCHAR(20)  NOT NULL DEFAULT 'AVAILABLE',
    certificate_uri       VARCHAR(500) NULL,
    note                  VARCHAR(500) NULL,
    created_at            DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at            DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
                                       ON UPDATE CURRENT_TIMESTAMP(6),
    UNIQUE KEY uq_calibrator_lot_level (calibrator_product_id, lot_number, level_code),
    UNIQUE KEY uq_calibrator_lot_product (calibrator_lot_id, calibrator_product_id),
    KEY idx_calibrator_lots_expiry_status (expiry_date, lot_status),
    CONSTRAINT chk_calibrator_lots_status
        CHECK (lot_status IN ('QUARANTINE','AVAILABLE','IN_USE','EXHAUSTED','EXPIRED','RECALLED')),
    CONSTRAINT chk_calibrator_lots_dates
        CHECK (expiry_date IS NULL OR received_at IS NULL OR expiry_date >= received_at),
    CONSTRAINT fk_calibrator_lots_product
        FOREIGN KEY (calibrator_product_id)
        REFERENCES calibrator_products(calibrator_product_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- B4. 品管目標值：每個 assay × QC 批號/濃度 的 mean/SD，且版本化
--     平測前用原廠值(MANUFACTURER)，平測後建立實驗室值(LAB)。
--     current_slot 讓「同一 assay+lot 只能有一筆生效中版本」由 DB 保證。
CREATE TABLE qc_target_values (
    qc_target_id    CHAR(36)      NOT NULL DEFAULT UUID() PRIMARY KEY,
    assay_id        CHAR(36)      NOT NULL,
    qc_lot_id       CHAR(36)      NOT NULL,
    qc_product_id   CHAR(36)      NOT NULL,
    target_source   VARCHAR(20)   NOT NULL COMMENT 'MANUFACTURER / LAB / PEER_GROUP',
    target_mean     DECIMAL(18,6) NOT NULL,
    target_sd       DECIMAL(18,6) NOT NULL,
    acceptable_low  DECIMAL(18,6) NULL,
    acceptable_high DECIMAL(18,6) NULL,
    effective_from  DATETIME(6)   NOT NULL,
    effective_to    DATETIME(6)   NULL COMMENT 'NULL = 目前生效中',
    approved_by     VARCHAR(100)  NULL,
    approved_at     DATETIME(6)   NULL,
    note            VARCHAR(500)  NULL,
    current_slot    TINYINT GENERATED ALWAYS AS
                    (CASE WHEN effective_to IS NULL THEN 1 ELSE NULL END) STORED,
    created_at      DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    UNIQUE KEY uq_qc_target_version (assay_id, qc_lot_id, effective_from),
    UNIQUE KEY uq_qc_target_current (assay_id, qc_lot_id, current_slot),
    UNIQUE KEY uq_qc_target_identity (qc_target_id, assay_id, qc_lot_id, qc_product_id),
    KEY idx_qc_target_lot_assay (qc_lot_id, assay_id),
    CONSTRAINT chk_qc_target_source
        CHECK (target_source IN ('MANUFACTURER', 'LAB', 'PEER_GROUP')),
    CONSTRAINT chk_qc_target_sd CHECK (target_sd > 0),
    CONSTRAINT chk_qc_target_range
        CHECK (acceptable_low IS NULL OR acceptable_high IS NULL
               OR acceptable_high >= acceptable_low),
    CONSTRAINT chk_qc_target_dates
        CHECK (effective_to IS NULL OR effective_to > effective_from),
    CONSTRAINT fk_qc_target_assay
        FOREIGN KEY (assay_id) REFERENCES instrument_assays(assay_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_qc_target_lot_product
        FOREIGN KEY (qc_lot_id, qc_product_id)
        REFERENCES qc_lots(qc_lot_id, qc_product_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    -- 保證此 QC 產品確實被該 assay 允許使用
    CONSTRAINT fk_qc_target_requirement
        FOREIGN KEY (assay_id, qc_product_id)
        REFERENCES assay_qc_requirements(assay_id, qc_product_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- B5. 試劑上機紀錄：哪一批試劑何時裝到哪台儀器哪個位置
CREATE TABLE instrument_reagent_loads (
    reagent_load_id CHAR(36)     NOT NULL DEFAULT UUID() PRIMARY KEY,
    instrument_id   CHAR(36)     NOT NULL,
    reagent_lot_id  CHAR(36)     NOT NULL,
    position_code   VARCHAR(50)  NOT NULL COMMENT '儀器上的位置代碼',
    loaded_at       DATETIME(6)  NOT NULL,
    unloaded_at     DATETIME(6)  NULL,
    loaded_by       VARCHAR(100) NULL,
    unloaded_by     VARCHAR(100) NULL,
    current_slot    TINYINT GENERATED ALWAYS AS
                    (CASE WHEN unloaded_at IS NULL THEN 1 ELSE NULL END) STORED,
    note            VARCHAR(500) NULL,
    created_at      DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    -- 同一台儀器同一位置同時只能有一批試劑在線上
    UNIQUE KEY uq_current_instrument_position (instrument_id, position_code, current_slot),
    KEY idx_reagent_load_lot_time (reagent_lot_id, loaded_at),
    CONSTRAINT chk_reagent_load_dates
        CHECK (unloaded_at IS NULL OR unloaded_at >= loaded_at),
    CONSTRAINT fk_reagent_load_instrument
        FOREIGN KEY (instrument_id) REFERENCES instruments(instrument_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_reagent_load_lot
        FOREIGN KEY (reagent_lot_id) REFERENCES reagent_lots(reagent_lot_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ==========================================================================
-- C. 交易／稽核層
-- ==========================================================================

-- C1. 一次品管執行（一瓶多項目品管液可產生多個項目結果）
CREATE TABLE qc_runs (
    qc_run_id         CHAR(36)      NOT NULL DEFAULT UUID() PRIMARY KEY,
    instrument_id     CHAR(36)      NOT NULL,
    qc_lot_id         CHAR(36)      NOT NULL,
    qc_product_id     CHAR(36)      NOT NULL,
    run_at            DATETIME(6)   NOT NULL,
    operator_id       VARCHAR(100)  NULL,
    instrument_run_id VARCHAR(120)  NULL COMMENT '儀器端的執行序號，供對帳',
    run_status        VARCHAR(20)   NOT NULL DEFAULT 'COMPLETED',
    note              VARCHAR(1000) NULL,
    created_at        DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    UNIQUE KEY uq_qc_run_instrument_ref (instrument_id, instrument_run_id),
    UNIQUE KEY uq_qc_run_identity (qc_run_id, instrument_id, qc_lot_id, qc_product_id),
    KEY idx_qc_runs_instrument_time (instrument_id, run_at),
    KEY idx_qc_runs_lot_time (qc_lot_id, run_at),
    CONSTRAINT chk_qc_runs_status
        CHECK (run_status IN ('COMPLETED', 'PARTIAL', 'CANCELLED')),
    CONSTRAINT fk_qc_runs_instrument
        FOREIGN KEY (instrument_id) REFERENCES instruments(instrument_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_qc_runs_lot_product
        FOREIGN KEY (qc_lot_id, qc_product_id)
        REFERENCES qc_lots(qc_lot_id, qc_product_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- C2. 單一項目的品管結果
--     刻意保存 mean/SD/unit 快照：主檔日後變更，歷史判讀仍能重現（稽核要求）。
CREATE TABLE qc_results (
    qc_result_id         CHAR(36)      NOT NULL DEFAULT UUID() PRIMARY KEY,
    qc_run_id            CHAR(36)      NOT NULL,
    instrument_id        CHAR(36)      NOT NULL,
    assay_id             CHAR(36)      NOT NULL,
    qc_lot_id            CHAR(36)      NOT NULL,
    qc_product_id        CHAR(36)      NOT NULL,
    qc_target_id         CHAR(36)      NULL COMMENT '當時採用的目標值版本',
    result_value         DECIMAL(18,6) NOT NULL,
    unit_snapshot        VARCHAR(50)   NULL,
    target_mean_snapshot DECIMAL(18,6) NULL,
    target_sd_snapshot   DECIMAL(18,6) NULL,
    z_score              DECIMAL(18,6) GENERATED ALWAYS AS
                         ((result_value - target_mean_snapshot)
                          / NULLIF(target_sd_snapshot, 0)) STORED,
    result_status        VARCHAR(20)   NOT NULL DEFAULT 'PASS',
    westgard_flags       JSON          NULL COMMENT '違反的規則清單，如 ["1-3s","2-2s"]',
    reviewed_by          VARCHAR(100)  NULL,
    reviewed_at          DATETIME(6)   NULL,
    note                 VARCHAR(1000) NULL,
    created_at           DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    UNIQUE KEY uq_qc_result_run_assay (qc_run_id, assay_id),
    UNIQUE KEY uq_qc_result_id_assay (qc_result_id, assay_id),
    KEY idx_qc_results_assay_run (assay_id, qc_run_id),
    KEY idx_qc_results_status_run (result_status, qc_run_id),
    KEY idx_qc_results_target (qc_target_id),
    CONSTRAINT chk_qc_results_status
        CHECK (result_status IN ('PASS', 'WARNING', 'FAIL', 'INVALID')),
    CONSTRAINT chk_qc_results_target_sd
        CHECK (target_sd_snapshot IS NULL OR target_sd_snapshot > 0),
    CONSTRAINT fk_qc_results_run_identity
        FOREIGN KEY (qc_run_id, instrument_id, qc_lot_id, qc_product_id)
        REFERENCES qc_runs(qc_run_id, instrument_id, qc_lot_id, qc_product_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    -- 保證結果的 assay 確實屬於該次 run 的儀器
    CONSTRAINT fk_qc_results_assay_instrument
        FOREIGN KEY (assay_id, instrument_id)
        REFERENCES instrument_assays(assay_id, instrument_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_qc_results_requirement
        FOREIGN KEY (assay_id, qc_product_id)
        REFERENCES assay_qc_requirements(assay_id, qc_product_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_qc_results_target
        FOREIGN KEY (qc_target_id, assay_id, qc_lot_id, qc_product_id)
        REFERENCES qc_target_values (qc_target_id, assay_id, qc_lot_id, qc_product_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- C3. 該筆品管結果實際使用的試劑批號（可多筆）
CREATE TABLE qc_result_reagents (
    qc_result_id       CHAR(36)    NOT NULL,
    assay_id           CHAR(36)    NOT NULL,
    reagent_lot_id     CHAR(36)    NOT NULL,
    reagent_product_id CHAR(36)    NOT NULL,
    reagent_role       VARCHAR(30) NOT NULL DEFAULT 'PRIMARY',
    created_at         DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (qc_result_id, reagent_lot_id, reagent_role),
    KEY idx_qrr_lot_result (reagent_lot_id, qc_result_id),
    CONSTRAINT chk_qrr_role
        CHECK (reagent_role IN ('PRIMARY', 'AUXILIARY', 'DILUENT', 'WASH', 'OTHER')),
    CONSTRAINT fk_qrr_result_assay
        FOREIGN KEY (qc_result_id, assay_id)
        REFERENCES qc_results(qc_result_id, assay_id)
        ON UPDATE RESTRICT ON DELETE CASCADE,
    CONSTRAINT fk_qrr_lot_product
        FOREIGN KEY (reagent_lot_id, reagent_product_id)
        REFERENCES reagent_lots(reagent_lot_id, reagent_product_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_qrr_requirement
        FOREIGN KEY (assay_id, reagent_product_id, reagent_role)
        REFERENCES assay_reagent_requirements(assay_id, reagent_product_id, reagent_role)
        ON UPDATE RESTRICT ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- C4. 校正事件（一次校正可涵蓋多個 assay）
CREATE TABLE calibration_events (
    calibration_event_id  CHAR(36)      NOT NULL DEFAULT UUID() PRIMARY KEY,
    instrument_id         CHAR(36)      NOT NULL,
    calibrator_lot_id     CHAR(36)      NOT NULL,
    calibrator_product_id CHAR(36)      NOT NULL,
    performed_at          DATETIME(6)   NOT NULL,
    operator_id           VARCHAR(100)  NULL,
    calibration_reason    VARCHAR(30)   NOT NULL DEFAULT 'SCHEDULED',
    event_status          VARCHAR(20)   NOT NULL,
    instrument_event_id   VARCHAR(120)  NULL,
    raw_data_uri          VARCHAR(500)  NULL,
    note                  VARCHAR(1000) NULL,
    created_at            DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    UNIQUE KEY uq_cal_event_instrument_ref (instrument_id, instrument_event_id),
    UNIQUE KEY uq_cal_event_identity
        (calibration_event_id, instrument_id, calibrator_product_id),
    KEY idx_cal_event_instrument_time (instrument_id, performed_at),
    KEY idx_cal_event_lot_time (calibrator_lot_id, performed_at),
    CONSTRAINT chk_cal_event_reason
        CHECK (calibration_reason IN ('SCHEDULED','NEW_LOT','QC_FAILURE','MAINTENANCE','OTHER')),
    CONSTRAINT chk_cal_event_status
        CHECK (event_status IN ('PASS', 'FAIL', 'CANCELLED')),
    CONSTRAINT fk_cal_event_instrument
        FOREIGN KEY (instrument_id) REFERENCES instruments(instrument_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_cal_event_lot_product
        FOREIGN KEY (calibrator_lot_id, calibrator_product_id)
        REFERENCES calibrator_lots(calibrator_lot_id, calibrator_product_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE calibration_event_assays (
    calibration_event_id  CHAR(36)      NOT NULL,
    instrument_id         CHAR(36)      NOT NULL,
    assay_id              CHAR(36)      NOT NULL,
    calibrator_product_id CHAR(36)      NOT NULL,
    assay_status          VARCHAR(20)   NOT NULL,
    pre_bias              DECIMAL(18,6) NULL,
    post_bias             DECIMAL(18,6) NULL,
    note                  VARCHAR(500)  NULL,
    created_at            DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (calibration_event_id, assay_id),
    KEY idx_cea_assay_event (assay_id, calibration_event_id),
    CONSTRAINT chk_cea_status
        CHECK (assay_status IN ('PASS', 'FAIL', 'NOT_EVALUATED')),
    CONSTRAINT fk_cea_event_identity
        FOREIGN KEY (calibration_event_id, instrument_id, calibrator_product_id)
        REFERENCES calibration_events
            (calibration_event_id, instrument_id, calibrator_product_id)
        ON UPDATE RESTRICT ON DELETE CASCADE,
    CONSTRAINT fk_cea_assay_instrument
        FOREIGN KEY (assay_id, instrument_id)
        REFERENCES instrument_assays(assay_id, instrument_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_cea_calibrator_requirement
        FOREIGN KEY (assay_id, calibrator_product_id)
        REFERENCES assay_calibrator_requirements(assay_id, calibrator_product_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE calibration_event_reagents (
    calibration_event_id CHAR(36)    NOT NULL,
    assay_id             CHAR(36)    NOT NULL,
    reagent_lot_id       CHAR(36)    NOT NULL,
    reagent_product_id   CHAR(36)    NOT NULL,
    reagent_role         VARCHAR(30) NOT NULL DEFAULT 'PRIMARY',
    created_at           DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (calibration_event_id, assay_id, reagent_lot_id, reagent_role),
    KEY idx_cer_lot_event (reagent_lot_id, calibration_event_id),
    CONSTRAINT chk_cer_role
        CHECK (reagent_role IN ('PRIMARY', 'AUXILIARY', 'DILUENT', 'WASH', 'OTHER')),
    CONSTRAINT fk_cer_event_assay
        FOREIGN KEY (calibration_event_id, assay_id)
        REFERENCES calibration_event_assays(calibration_event_id, assay_id)
        ON UPDATE RESTRICT ON DELETE CASCADE,
    CONSTRAINT fk_cer_lot_product
        FOREIGN KEY (reagent_lot_id, reagent_product_id)
        REFERENCES reagent_lots(reagent_lot_id, reagent_product_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_cer_requirement
        FOREIGN KEY (assay_id, reagent_product_id, reagent_role)
        REFERENCES assay_reagent_requirements(assay_id, reagent_product_id, reagent_role)
        ON UPDATE RESTRICT ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ==========================================================================
-- D. 讀取用 View
-- ==========================================================================

CREATE VIEW v_assay_catalog AS
SELECT
    a.assay_id,
    s.section_id,
    s.section_code,
    s.section_name,
    i.instrument_id,
    i.serial_number,
    i.instrument_name,
    i.instrument_role,
    t.test_item_id,
    t.item_code,
    t.item_name,
    sp.specimen_type_id,
    sp.specimen_code,
    sp.specimen_name,
    a.method_name,
    COALESCE(a.result_unit, t.default_unit) AS result_unit,
    a.decimal_places,
    a.active
FROM instrument_assays AS a
JOIN instruments    AS i  ON i.instrument_id    = a.instrument_id
JOIN lab_sections   AS s  ON s.section_id       = i.section_id
JOIN test_items     AS t  ON t.test_item_id     = a.test_item_id
JOIN specimen_types AS sp ON sp.specimen_type_id = a.specimen_type_id;

CREATE VIEW v_qc_result_detail AS
SELECT
    qr.qc_result_id,
    qrun.qc_run_id,
    qrun.run_at,
    qrun.instrument_run_id,
    qrun.operator_id,
    vac.section_name,
    vac.instrument_id,
    vac.serial_number,
    vac.instrument_name,
    vac.instrument_role,
    vac.assay_id,
    vac.item_code,
    vac.item_name,
    vac.specimen_code,
    vac.specimen_name,
    qp.product_code AS qc_product_code,
    qp.product_name AS qc_product_name,
    ql.lot_number   AS qc_lot_number,
    ql.level_code   AS qc_level,
    qr.result_value,
    qr.unit_snapshot,
    qr.target_mean_snapshot,
    qr.target_sd_snapshot,
    qr.z_score,
    qr.result_status,
    qr.westgard_flags,
    qr.reviewed_by,
    qr.reviewed_at,
    qr.note
FROM qc_results AS qr
JOIN qc_runs         AS qrun ON qrun.qc_run_id     = qr.qc_run_id
JOIN v_assay_catalog AS vac  ON vac.assay_id       = qr.assay_id
JOIN qc_lots         AS ql   ON ql.qc_lot_id       = qr.qc_lot_id
JOIN qc_products     AS qp   ON qp.qc_product_id   = ql.qc_product_id;


-- ==========================================================================
-- E. 種子資料（沿用既有的組別與檢體別）
-- ==========================================================================

INSERT INTO lab_sections (section_code, section_name, description) VALUES
    ('BIO',   '生化免疫組', '臨床生化與免疫檢驗'),
    ('HEM',   '血液組',     '血液學與凝固檢驗'),
    ('URN',   '鏡檢組',     '尿液與鏡檢'),
    ('BB',    '血庫組',     '輸血醫學 / 血庫');

INSERT INTO specimen_types (specimen_code, specimen_name, description) VALUES
    ('B',   'BLOOD',      '全血 / 血清 / 血漿'),
    ('U',   'URINE',      '尿液'),
    ('CSF', 'CSF',        '腦脊髓液'),
    ('BF',  'BODY FLUID', '體液（胸水 / 腹水等）'),
    ('ST',  'STOOL',      '糞便');

-- 腳本結束。
