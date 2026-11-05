-- PostgreSQL v3. Apply once to an empty PJQAQC Supabase project.
BEGIN;
CREATE SCHEMA qaqc;
REVOKE ALL ON SCHEMA qaqc FROM PUBLIC;
SET LOCAL search_path TO qaqc, pg_catalog;
SET LOCAL TIME ZONE 'Asia/Taipei';

CREATE COLLATION qaqc.case_accent_insensitive
    (provider = icu, locale = 'und-u-ks-level1', deterministic = false);

-- A. 主檔／框架設定層
-- ==========================================================================

-- A1. 科別 / 組別
CREATE TABLE lab_sections (
    section_id   VARCHAR(36)     NOT NULL DEFAULT (gen_random_uuid()::text) PRIMARY KEY,
    section_code VARCHAR(30) COLLATE qaqc.case_accent_insensitive  NOT NULL,
    section_name VARCHAR(100) COLLATE qaqc.case_accent_insensitive NOT NULL,
    description  VARCHAR(500) COLLATE qaqc.case_accent_insensitive NULL,
    active       BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at   TIMESTAMP(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at   TIMESTAMP(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    CONSTRAINT uq_lab_sections_code UNIQUE (section_code),
    CONSTRAINT uq_lab_sections_name UNIQUE (section_name)
);


-- A2. 儀器實體（以序號唯一識別）
CREATE TABLE instruments (
    instrument_id   VARCHAR(36)     NOT NULL DEFAULT (gen_random_uuid()::text) PRIMARY KEY,
    section_id      VARCHAR(36)     NOT NULL,
    serial_number   VARCHAR(100) COLLATE qaqc.case_accent_insensitive NOT NULL,
    instrument_name VARCHAR(150) COLLATE qaqc.case_accent_insensitive NOT NULL,
    manufacturer    VARCHAR(150) COLLATE qaqc.case_accent_insensitive NULL,
    model_name      VARCHAR(100) COLLATE qaqc.case_accent_insensitive NULL,
    instrument_role VARCHAR(20) COLLATE qaqc.case_accent_insensitive  NOT NULL DEFAULT '主機',
    backup_of_instrument_id VARCHAR(36) NULL,
    active          BOOLEAN      NOT NULL DEFAULT TRUE,
    installed_at    DATE         NULL,
    retired_at      DATE         NULL,
    created_at      TIMESTAMP(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at      TIMESTAMP(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    CONSTRAINT uq_instruments_serial UNIQUE (serial_number),
    CONSTRAINT chk_instruments_role
        CHECK (instrument_role IN ('主機', '備機', '其他')),
    CONSTRAINT chk_instruments_dates
        CHECK (retired_at IS NULL OR installed_at IS NULL OR retired_at >= installed_at),
    CONSTRAINT fk_instruments_section
        FOREIGN KEY (section_id) REFERENCES lab_sections(section_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_instruments_backup_of
        FOREIGN KEY (backup_of_instrument_id) REFERENCES instruments(instrument_id)
        ON UPDATE RESTRICT ON DELETE SET NULL DEFERRABLE INITIALLY IMMEDIATE
);
CREATE INDEX idx_instruments_section_active ON instruments (section_id, active);
CREATE INDEX idx_instruments_backup_of ON instruments (backup_of_instrument_id);


-- A3. 檢體別字典
CREATE TABLE specimen_types (
    specimen_type_id VARCHAR(36)     NOT NULL DEFAULT (gen_random_uuid()::text) PRIMARY KEY,
    specimen_code    VARCHAR(30) COLLATE qaqc.case_accent_insensitive  NOT NULL,
    specimen_name    VARCHAR(100) COLLATE qaqc.case_accent_insensitive NOT NULL,
    description      VARCHAR(500) COLLATE qaqc.case_accent_insensitive NULL,
    active           BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at       TIMESTAMP(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at       TIMESTAMP(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    CONSTRAINT uq_specimen_types_code UNIQUE (specimen_code)
);


-- A4. 檢驗項目字典（全院共用；不再綁儀器）
CREATE TABLE test_items (
    test_item_id VARCHAR(36)     NOT NULL DEFAULT (gen_random_uuid()::text) PRIMARY KEY,
    item_code    VARCHAR(50) COLLATE qaqc.case_accent_insensitive  NOT NULL,
    item_name    VARCHAR(150) COLLATE qaqc.case_accent_insensitive NULL,
    loinc_code   VARCHAR(30) COLLATE qaqc.case_accent_insensitive  NULL,
    default_unit VARCHAR(50) COLLATE qaqc.case_accent_insensitive  NULL,
    description  VARCHAR(500) COLLATE qaqc.case_accent_insensitive NULL,
    active       BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at   TIMESTAMP(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at   TIMESTAMP(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    CONSTRAINT uq_test_items_code UNIQUE (item_code)
);
CREATE INDEX idx_test_items_name ON test_items (item_name);


-- A5. 檢驗設定（整個模型的中心）= 儀器 × 項目 × 檢體
CREATE TABLE instrument_assays (
    assay_id             VARCHAR(36)     NOT NULL DEFAULT (gen_random_uuid()::text) PRIMARY KEY,
    instrument_id        VARCHAR(36)     NOT NULL,
    test_item_id         VARCHAR(36)     NOT NULL,
    specimen_type_id     VARCHAR(36)     NOT NULL,
    instrument_test_code VARCHAR(80) COLLATE qaqc.case_accent_insensitive  NULL,
    method_name          VARCHAR(150) COLLATE qaqc.case_accent_insensitive NULL,
    result_unit          VARCHAR(50) COLLATE qaqc.case_accent_insensitive  NULL,
    decimal_places       SMALLINT CHECK (decimal_places BETWEEN 0 AND 255) NOT NULL DEFAULT 2,
    active               BOOLEAN      NOT NULL DEFAULT TRUE,
    valid_from           DATE         NULL,
    valid_to             DATE         NULL,
    created_at           TIMESTAMP(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at           TIMESTAMP(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    CONSTRAINT uq_assay_route UNIQUE (instrument_id, test_item_id, specimen_type_id),
    -- 供下游以複合 FK 確保「結果確實屬於該儀器」
    CONSTRAINT uq_assay_id_instrument UNIQUE (assay_id, instrument_id),
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
);
CREATE INDEX idx_assays_item_specimen ON instrument_assays (test_item_id, specimen_type_id, active);
CREATE INDEX idx_assays_specimen_item ON instrument_assays (specimen_type_id, test_item_id, active);


-- A6. 三種產品主檔（皆不放批號；不綁儀器，靠 requirement 連到 assay）
CREATE TABLE reagent_products (
    reagent_product_id VARCHAR(36)     NOT NULL DEFAULT (gen_random_uuid()::text) PRIMARY KEY,
    product_code       VARCHAR(60) COLLATE qaqc.case_accent_insensitive  NOT NULL,
    product_name       VARCHAR(180) COLLATE qaqc.case_accent_insensitive NOT NULL,
    manufacturer       VARCHAR(150) COLLATE qaqc.case_accent_insensitive NULL,
    catalog_number     VARCHAR(100) COLLATE qaqc.case_accent_insensitive NULL,
    storage_condition  VARCHAR(255) COLLATE qaqc.case_accent_insensitive NULL,
    active             BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at         TIMESTAMP(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at         TIMESTAMP(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    CONSTRAINT uq_reagent_products_code UNIQUE (product_code)
);
CREATE INDEX idx_reagent_products_name ON reagent_products (product_name);

CREATE TABLE qc_products (
    qc_product_id      VARCHAR(36)     NOT NULL DEFAULT (gen_random_uuid()::text) PRIMARY KEY,
    product_code       VARCHAR(60) COLLATE qaqc.case_accent_insensitive  NOT NULL,
    product_name       VARCHAR(180) COLLATE qaqc.case_accent_insensitive NOT NULL,
    manufacturer       VARCHAR(150) COLLATE qaqc.case_accent_insensitive NULL,
    catalog_number     VARCHAR(100) COLLATE qaqc.case_accent_insensitive NULL,
    matrix_description VARCHAR(255) COLLATE qaqc.case_accent_insensitive NULL,
    storage_condition  VARCHAR(255) COLLATE qaqc.case_accent_insensitive NULL,
    active             BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at         TIMESTAMP(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at         TIMESTAMP(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    CONSTRAINT uq_qc_products_code UNIQUE (product_code)
);
CREATE INDEX idx_qc_products_name ON qc_products (product_name);

CREATE TABLE calibrator_products (
    calibrator_product_id VARCHAR(36)     NOT NULL DEFAULT (gen_random_uuid()::text) PRIMARY KEY,
    product_code          VARCHAR(60) COLLATE qaqc.case_accent_insensitive  NOT NULL,
    product_name          VARCHAR(180) COLLATE qaqc.case_accent_insensitive NOT NULL,
    manufacturer          VARCHAR(150) COLLATE qaqc.case_accent_insensitive NULL,
    catalog_number        VARCHAR(100) COLLATE qaqc.case_accent_insensitive NULL,
    matrix_description    VARCHAR(255) COLLATE qaqc.case_accent_insensitive NULL,
    storage_condition     VARCHAR(255) COLLATE qaqc.case_accent_insensitive NULL,
    active                BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at            TIMESTAMP(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at            TIMESTAMP(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    CONSTRAINT uq_calibrator_products_code UNIQUE (product_code)
);
CREATE INDEX idx_calibrator_products_name ON calibrator_products (product_name);


-- A7. 三張 N:M mapping（assay ↔ 產品）
-- 一個 assay 可能需要多支試劑（主試劑 / 稀釋液 / 清洗液），同一支試劑也可服務多個 assay
CREATE TABLE assay_reagent_requirements (
    assay_id           VARCHAR(36)     NOT NULL,
    reagent_product_id VARCHAR(36)     NOT NULL,
    reagent_role       VARCHAR(30) COLLATE qaqc.case_accent_insensitive  NOT NULL DEFAULT 'PRIMARY',
    required           BOOLEAN      NOT NULL DEFAULT TRUE,
    priority           INTEGER CHECK (priority BETWEEN 0 AND 65535) NOT NULL DEFAULT 1,
    note               VARCHAR(500) COLLATE qaqc.case_accent_insensitive NULL,
    created_at         TIMESTAMP(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (assay_id, reagent_product_id, reagent_role),
    CONSTRAINT chk_arr_role
        CHECK (reagent_role IN ('PRIMARY', 'AUXILIARY', 'DILUENT', 'WASH', 'OTHER')),
    CONSTRAINT fk_arr_assay
        FOREIGN KEY (assay_id) REFERENCES instrument_assays(assay_id)
        ON UPDATE RESTRICT ON DELETE CASCADE,
    CONSTRAINT fk_arr_product
        FOREIGN KEY (reagent_product_id) REFERENCES reagent_products(reagent_product_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE INDEX idx_arr_product_assay ON assay_reagent_requirements (reagent_product_id, assay_id);

-- 一瓶多項目品管液可涵蓋多個 assay
CREATE TABLE assay_qc_requirements (
    assay_id      VARCHAR(36)     NOT NULL,
    qc_product_id VARCHAR(36)     NOT NULL,
    required      BOOLEAN      NOT NULL DEFAULT TRUE,
    priority      INTEGER CHECK (priority BETWEEN 0 AND 65535) NOT NULL DEFAULT 1,
    note          VARCHAR(500) COLLATE qaqc.case_accent_insensitive NULL,
    created_at    TIMESTAMP(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (assay_id, qc_product_id),
    CONSTRAINT fk_aqr_assay
        FOREIGN KEY (assay_id) REFERENCES instrument_assays(assay_id)
        ON UPDATE RESTRICT ON DELETE CASCADE,
    CONSTRAINT fk_aqr_product
        FOREIGN KEY (qc_product_id) REFERENCES qc_products(qc_product_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE INDEX idx_aqr_product_assay ON assay_qc_requirements (qc_product_id, assay_id);

CREATE TABLE assay_calibrator_requirements (
    assay_id              VARCHAR(36)     NOT NULL,
    calibrator_product_id VARCHAR(36)     NOT NULL,
    required              BOOLEAN      NOT NULL DEFAULT TRUE,
    priority              INTEGER CHECK (priority BETWEEN 0 AND 65535) NOT NULL DEFAULT 1,
    note                  VARCHAR(500) COLLATE qaqc.case_accent_insensitive NULL,
    created_at            TIMESTAMP(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (assay_id, calibrator_product_id),
    CONSTRAINT fk_acr_assay
        FOREIGN KEY (assay_id) REFERENCES instrument_assays(assay_id)
        ON UPDATE RESTRICT ON DELETE CASCADE,
    CONSTRAINT fk_acr_product
        FOREIGN KEY (calibrator_product_id)
        REFERENCES calibrator_products(calibrator_product_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE INDEX idx_acr_product_assay ON assay_calibrator_requirements (calibrator_product_id, assay_id);


-- ==========================================================================
-- B. 批號／庫存實體層
--    換批號只新增 lot，不新建 product；設定與關聯完全不受影響。
-- ==========================================================================

-- B1. 試劑批號（含本系統既有的「入庫 / 平測 / 批號延續性」欄位）
CREATE TABLE reagent_lots (
    reagent_lot_id     VARCHAR(36)     NOT NULL DEFAULT (gen_random_uuid()::text) PRIMARY KEY,
    reagent_product_id VARCHAR(36)     NOT NULL,
    lot_number         VARCHAR(100) COLLATE qaqc.case_accent_insensitive NOT NULL,
    received_at        DATE         NULL,
    opened_at          TIMESTAMP(6)  NULL,
    expiry_date        DATE         NULL,
    quantity_received  DECIMAL(14,3) NULL,
    quantity_unit      VARCHAR(30) COLLATE qaqc.case_accent_insensitive  NULL,
    lot_status         VARCHAR(20) COLLATE qaqc.case_accent_insensitive  NOT NULL DEFAULT 'AVAILABLE',
    -- 既有系統的平測流程（參考設計未涵蓋，此處保留）
    parallel_test_done BOOLEAN      NOT NULL DEFAULT FALSE,
    parallel_test_date DATE         NULL,
    same_lot_as_previous BOOLEAN    NOT NULL DEFAULT FALSE,
    previous_reagent_lot_id VARCHAR(36) NULL,
    certificate_uri    VARCHAR(500) COLLATE qaqc.case_accent_insensitive NULL,
    note               VARCHAR(500) COLLATE qaqc.case_accent_insensitive NULL,
    created_at         TIMESTAMP(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at         TIMESTAMP(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    CONSTRAINT uq_reagent_lot UNIQUE (reagent_product_id, lot_number),
    CONSTRAINT uq_reagent_lot_product UNIQUE (reagent_lot_id, reagent_product_id),
    CONSTRAINT chk_reagent_lots_status
        CHECK (lot_status IN ('QUARANTINE','AVAILABLE','IN_USE','EXHAUSTED','EXPIRED','RECALLED')),
    CONSTRAINT chk_reagent_lots_dates
        CHECK (expiry_date IS NULL OR received_at IS NULL OR expiry_date >= received_at),
    CONSTRAINT fk_reagent_lots_product
        FOREIGN KEY (reagent_product_id) REFERENCES reagent_products(reagent_product_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_reagent_lots_prev
        FOREIGN KEY (previous_reagent_lot_id) REFERENCES reagent_lots(reagent_lot_id)
        ON UPDATE RESTRICT ON DELETE SET NULL DEFERRABLE INITIALLY IMMEDIATE
);
CREATE INDEX idx_reagent_lots_expiry_status ON reagent_lots (expiry_date, lot_status);
CREATE INDEX idx_reagent_lots_prev ON reagent_lots (previous_reagent_lot_id);


-- B2. 品管液批號：同一 kit 的 Level 1/2/3 各一列
CREATE TABLE qc_lots (
    qc_lot_id          VARCHAR(36)     NOT NULL DEFAULT (gen_random_uuid()::text) PRIMARY KEY,
    qc_product_id      VARCHAR(36)     NOT NULL,
    lot_number         VARCHAR(100) COLLATE qaqc.case_accent_insensitive NOT NULL,
    level_code         VARCHAR(30) COLLATE qaqc.case_accent_insensitive  NOT NULL,
    received_at        DATE         NULL,
    opened_at          TIMESTAMP(6)  NULL,
    expiry_date        DATE         NULL,
    lot_status         VARCHAR(20) COLLATE qaqc.case_accent_insensitive  NOT NULL DEFAULT 'AVAILABLE',
    -- 平測狀態；平測後的實際 mean/SD 以 qc_target_values(target_source='LAB') 表示
    parallel_test_done BOOLEAN      NOT NULL DEFAULT FALSE,
    parallel_test_date DATE         NULL,
    certificate_uri    VARCHAR(500) COLLATE qaqc.case_accent_insensitive NULL,
    note               VARCHAR(500) COLLATE qaqc.case_accent_insensitive NULL,
    created_at         TIMESTAMP(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at         TIMESTAMP(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    CONSTRAINT uq_qc_lot_level UNIQUE (qc_product_id, lot_number, level_code),
    CONSTRAINT uq_qc_lot_product UNIQUE (qc_lot_id, qc_product_id),
    CONSTRAINT chk_qc_lots_status
        CHECK (lot_status IN ('QUARANTINE','AVAILABLE','IN_USE','EXHAUSTED','EXPIRED','RECALLED')),
    CONSTRAINT chk_qc_lots_dates
        CHECK (expiry_date IS NULL OR received_at IS NULL OR expiry_date >= received_at),
    CONSTRAINT fk_qc_lots_product
        FOREIGN KEY (qc_product_id) REFERENCES qc_products(qc_product_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE INDEX idx_qc_lots_expiry_status ON qc_lots (expiry_date, lot_status);


-- B3. 校正液批號
CREATE TABLE calibrator_lots (
    calibrator_lot_id     VARCHAR(36)     NOT NULL DEFAULT (gen_random_uuid()::text) PRIMARY KEY,
    calibrator_product_id VARCHAR(36)     NOT NULL,
    lot_number            VARCHAR(100) COLLATE qaqc.case_accent_insensitive NOT NULL,
    level_code            VARCHAR(30) COLLATE qaqc.case_accent_insensitive  NOT NULL DEFAULT 'DEFAULT',
    assigned_value_text   VARCHAR(500) COLLATE qaqc.case_accent_insensitive NULL,
    received_at           DATE         NULL,
    opened_at             TIMESTAMP(6)  NULL,
    expiry_date           DATE         NULL,
    lot_status            VARCHAR(20) COLLATE qaqc.case_accent_insensitive  NOT NULL DEFAULT 'AVAILABLE',
    certificate_uri       VARCHAR(500) COLLATE qaqc.case_accent_insensitive NULL,
    note                  VARCHAR(500) COLLATE qaqc.case_accent_insensitive NULL,
    created_at            TIMESTAMP(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at            TIMESTAMP(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    CONSTRAINT uq_calibrator_lot_level UNIQUE (calibrator_product_id, lot_number, level_code),
    CONSTRAINT uq_calibrator_lot_product UNIQUE (calibrator_lot_id, calibrator_product_id),
    CONSTRAINT chk_calibrator_lots_status
        CHECK (lot_status IN ('QUARANTINE','AVAILABLE','IN_USE','EXHAUSTED','EXPIRED','RECALLED')),
    CONSTRAINT chk_calibrator_lots_dates
        CHECK (expiry_date IS NULL OR received_at IS NULL OR expiry_date >= received_at),
    CONSTRAINT fk_calibrator_lots_product
        FOREIGN KEY (calibrator_product_id)
        REFERENCES calibrator_products(calibrator_product_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE INDEX idx_calibrator_lots_expiry_status ON calibrator_lots (expiry_date, lot_status);


-- B4. 品管目標值：每個 assay × QC 批號/濃度 的 mean/SD，且版本化
--     平測前用原廠值(MANUFACTURER)，平測後建立實驗室值(LAB)。
--     current_slot 讓「同一 assay+lot 只能有一筆生效中版本」由 DB 保證。
CREATE TABLE qc_target_values (
    qc_target_id    VARCHAR(36)      NOT NULL DEFAULT (gen_random_uuid()::text) PRIMARY KEY,
    assay_id        VARCHAR(36)      NOT NULL,
    qc_lot_id       VARCHAR(36)      NOT NULL,
    qc_product_id   VARCHAR(36)      NOT NULL,
    target_source   VARCHAR(20) COLLATE qaqc.case_accent_insensitive   NOT NULL,
    target_mean     DECIMAL(18,6) NOT NULL,
    target_sd       DECIMAL(18,6) NOT NULL,
    acceptable_low  DECIMAL(18,6) NULL,
    acceptable_high DECIMAL(18,6) NULL,
    effective_from  TIMESTAMP(6)   NOT NULL,
    effective_to    TIMESTAMP(6)   NULL,
    approved_by     VARCHAR(100) COLLATE qaqc.case_accent_insensitive  NULL,
    approved_at     TIMESTAMP(6)   NULL,
    note            VARCHAR(500) COLLATE qaqc.case_accent_insensitive  NULL,
    current_slot    SMALLINT GENERATED ALWAYS AS
                    (CASE WHEN effective_to IS NULL THEN 1 ELSE NULL END) STORED,
    created_at      TIMESTAMP(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    CONSTRAINT uq_qc_target_version UNIQUE (assay_id, qc_lot_id, effective_from),
    CONSTRAINT uq_qc_target_current UNIQUE (assay_id, qc_lot_id, current_slot),
    CONSTRAINT uq_qc_target_identity UNIQUE (qc_target_id, assay_id, qc_lot_id, qc_product_id),
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
);
CREATE INDEX idx_qc_target_lot_assay ON qc_target_values (qc_lot_id, assay_id);


-- B5. 試劑上機紀錄：哪一批試劑何時裝到哪台儀器哪個位置
CREATE TABLE instrument_reagent_loads (
    reagent_load_id VARCHAR(36)     NOT NULL DEFAULT (gen_random_uuid()::text) PRIMARY KEY,
    instrument_id   VARCHAR(36)     NOT NULL,
    reagent_lot_id  VARCHAR(36)     NOT NULL,
    position_code   VARCHAR(50) COLLATE qaqc.case_accent_insensitive  NOT NULL,
    loaded_at       TIMESTAMP(6)  NOT NULL,
    unloaded_at     TIMESTAMP(6)  NULL,
    loaded_by       VARCHAR(100) COLLATE qaqc.case_accent_insensitive NULL,
    unloaded_by     VARCHAR(100) COLLATE qaqc.case_accent_insensitive NULL,
    current_slot    SMALLINT GENERATED ALWAYS AS
                    (CASE WHEN unloaded_at IS NULL THEN 1 ELSE NULL END) STORED,
    note            VARCHAR(500) COLLATE qaqc.case_accent_insensitive NULL,
    created_at      TIMESTAMP(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    -- 同一台儀器同一位置同時只能有一批試劑在線上
    CONSTRAINT uq_current_instrument_position UNIQUE (instrument_id, position_code, current_slot),
    CONSTRAINT chk_reagent_load_dates
        CHECK (unloaded_at IS NULL OR unloaded_at >= loaded_at),
    CONSTRAINT fk_reagent_load_instrument
        FOREIGN KEY (instrument_id) REFERENCES instruments(instrument_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_reagent_load_lot
        FOREIGN KEY (reagent_lot_id) REFERENCES reagent_lots(reagent_lot_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE INDEX idx_reagent_load_lot_time ON instrument_reagent_loads (reagent_lot_id, loaded_at);


-- ==========================================================================
-- C. 交易／稽核層
-- ==========================================================================

-- C1. 一次品管執行（一瓶多項目品管液可產生多個項目結果）
CREATE TABLE qc_runs (
    qc_run_id         VARCHAR(36)      NOT NULL DEFAULT (gen_random_uuid()::text) PRIMARY KEY,
    instrument_id     VARCHAR(36)      NOT NULL,
    qc_lot_id         VARCHAR(36)      NOT NULL,
    qc_product_id     VARCHAR(36)      NOT NULL,
    run_at            TIMESTAMP(6)   NOT NULL,
    operator_id       VARCHAR(100) COLLATE qaqc.case_accent_insensitive  NULL,
    instrument_run_id VARCHAR(120) COLLATE qaqc.case_accent_insensitive  NULL,
    run_status        VARCHAR(20) COLLATE qaqc.case_accent_insensitive   NOT NULL DEFAULT 'COMPLETED',
    note              VARCHAR(1000) COLLATE qaqc.case_accent_insensitive NULL,
    created_at        TIMESTAMP(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    CONSTRAINT uq_qc_run_instrument_ref UNIQUE (instrument_id, instrument_run_id),
    CONSTRAINT uq_qc_run_identity UNIQUE (qc_run_id, instrument_id, qc_lot_id, qc_product_id),
    CONSTRAINT chk_qc_runs_status
        CHECK (run_status IN ('COMPLETED', 'PARTIAL', 'CANCELLED')),
    CONSTRAINT fk_qc_runs_instrument
        FOREIGN KEY (instrument_id) REFERENCES instruments(instrument_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_qc_runs_lot_product
        FOREIGN KEY (qc_lot_id, qc_product_id)
        REFERENCES qc_lots(qc_lot_id, qc_product_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE INDEX idx_qc_runs_instrument_time ON qc_runs (instrument_id, run_at);
CREATE INDEX idx_qc_runs_lot_time ON qc_runs (qc_lot_id, run_at);


-- C2. 單一項目的品管結果
--     刻意保存 mean/SD/unit 快照：主檔日後變更，歷史判讀仍能重現（稽核要求）。
CREATE TABLE qc_results (
    qc_result_id         VARCHAR(36)      NOT NULL DEFAULT (gen_random_uuid()::text) PRIMARY KEY,
    qc_run_id            VARCHAR(36)      NOT NULL,
    instrument_id        VARCHAR(36)      NOT NULL,
    assay_id             VARCHAR(36)      NOT NULL,
    qc_lot_id            VARCHAR(36)      NOT NULL,
    qc_product_id        VARCHAR(36)      NOT NULL,
    qc_target_id         VARCHAR(36)      NULL,
    result_value         DECIMAL(18,6) NOT NULL,
    unit_snapshot        VARCHAR(50) COLLATE qaqc.case_accent_insensitive   NULL,
    target_mean_snapshot DECIMAL(18,6) NULL,
    target_sd_snapshot   DECIMAL(18,6) NULL,
    z_score              DECIMAL(18,6) GENERATED ALWAYS AS
                         ((result_value - target_mean_snapshot)
                          / NULLIF(target_sd_snapshot, 0)) STORED,
    result_status        VARCHAR(20) COLLATE qaqc.case_accent_insensitive   NOT NULL DEFAULT 'PASS',
    westgard_flags       JSONB          NULL,
    reviewed_by          VARCHAR(100) COLLATE qaqc.case_accent_insensitive  NULL,
    reviewed_at          TIMESTAMP(6)   NULL,
    note                 VARCHAR(1000) COLLATE qaqc.case_accent_insensitive NULL,
    created_at           TIMESTAMP(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    CONSTRAINT uq_qc_result_run_assay UNIQUE (qc_run_id, assay_id),
    CONSTRAINT uq_qc_result_id_assay UNIQUE (qc_result_id, assay_id),
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
);
CREATE INDEX idx_qc_results_assay_run ON qc_results (assay_id, qc_run_id);
CREATE INDEX idx_qc_results_status_run ON qc_results (result_status, qc_run_id);
CREATE INDEX idx_qc_results_target ON qc_results (qc_target_id);


-- C3. 該筆品管結果實際使用的試劑批號（可多筆）
CREATE TABLE qc_result_reagents (
    qc_result_id       VARCHAR(36)    NOT NULL,
    assay_id           VARCHAR(36)    NOT NULL,
    reagent_lot_id     VARCHAR(36)    NOT NULL,
    reagent_product_id VARCHAR(36)    NOT NULL,
    reagent_role       VARCHAR(30) COLLATE qaqc.case_accent_insensitive NOT NULL DEFAULT 'PRIMARY',
    created_at         TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (qc_result_id, reagent_lot_id, reagent_role),
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
);
CREATE INDEX idx_qrr_lot_result ON qc_result_reagents (reagent_lot_id, qc_result_id);


-- C4. 校正事件（一次校正可涵蓋多個 assay）
CREATE TABLE calibration_events (
    calibration_event_id  VARCHAR(36)      NOT NULL DEFAULT (gen_random_uuid()::text) PRIMARY KEY,
    instrument_id         VARCHAR(36)      NOT NULL,
    calibrator_lot_id     VARCHAR(36)      NOT NULL,
    calibrator_product_id VARCHAR(36)      NOT NULL,
    performed_at          TIMESTAMP(6)   NOT NULL,
    operator_id           VARCHAR(100) COLLATE qaqc.case_accent_insensitive  NULL,
    calibration_reason    VARCHAR(30) COLLATE qaqc.case_accent_insensitive   NOT NULL DEFAULT 'SCHEDULED',
    event_status          VARCHAR(20) COLLATE qaqc.case_accent_insensitive   NOT NULL,
    instrument_event_id   VARCHAR(120) COLLATE qaqc.case_accent_insensitive  NULL,
    raw_data_uri          VARCHAR(500) COLLATE qaqc.case_accent_insensitive  NULL,
    note                  VARCHAR(1000) COLLATE qaqc.case_accent_insensitive NULL,
    created_at            TIMESTAMP(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    CONSTRAINT uq_cal_event_instrument_ref UNIQUE (instrument_id, instrument_event_id),
    CONSTRAINT uq_cal_event_identity UNIQUE (calibration_event_id, instrument_id, calibrator_product_id),
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
);
CREATE INDEX idx_cal_event_instrument_time ON calibration_events (instrument_id, performed_at);
CREATE INDEX idx_cal_event_lot_time ON calibration_events (calibrator_lot_id, performed_at);

CREATE TABLE calibration_event_assays (
    calibration_event_id  VARCHAR(36)      NOT NULL,
    instrument_id         VARCHAR(36)      NOT NULL,
    assay_id              VARCHAR(36)      NOT NULL,
    calibrator_product_id VARCHAR(36)      NOT NULL,
    assay_status          VARCHAR(20) COLLATE qaqc.case_accent_insensitive   NOT NULL,
    pre_bias              DECIMAL(18,6) NULL,
    post_bias             DECIMAL(18,6) NULL,
    note                  VARCHAR(500) COLLATE qaqc.case_accent_insensitive  NULL,
    created_at            TIMESTAMP(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (calibration_event_id, assay_id),
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
);
CREATE INDEX idx_cea_assay_event ON calibration_event_assays (assay_id, calibration_event_id);

CREATE TABLE calibration_event_reagents (
    calibration_event_id VARCHAR(36)    NOT NULL,
    assay_id             VARCHAR(36)    NOT NULL,
    reagent_lot_id       VARCHAR(36)    NOT NULL,
    reagent_product_id   VARCHAR(36)    NOT NULL,
    reagent_role         VARCHAR(30) COLLATE qaqc.case_accent_insensitive NOT NULL DEFAULT 'PRIMARY',
    created_at           TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (calibration_event_id, assay_id, reagent_lot_id, reagent_role),
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
);
CREATE INDEX idx_cer_lot_event ON calibration_event_reagents (reagent_lot_id, calibration_event_id);


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

CREATE FUNCTION qaqc.set_updated_at() RETURNS trigger
LANGUAGE plpgsql SET search_path TO pg_catalog AS $$
BEGIN
    -- The v3 schema stores laboratory wall time.
    IF NEW IS DISTINCT FROM OLD AND NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at THEN
        NEW.updated_at := statement_timestamp() AT TIME ZONE 'Asia/Taipei';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER set_updated_at BEFORE UPDATE ON lab_sections
    FOR EACH ROW EXECUTE FUNCTION qaqc.set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON instruments
    FOR EACH ROW EXECUTE FUNCTION qaqc.set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON specimen_types
    FOR EACH ROW EXECUTE FUNCTION qaqc.set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON test_items
    FOR EACH ROW EXECUTE FUNCTION qaqc.set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON instrument_assays
    FOR EACH ROW EXECUTE FUNCTION qaqc.set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON reagent_products
    FOR EACH ROW EXECUTE FUNCTION qaqc.set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON qc_products
    FOR EACH ROW EXECUTE FUNCTION qaqc.set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON calibrator_products
    FOR EACH ROW EXECUTE FUNCTION qaqc.set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON reagent_lots
    FOR EACH ROW EXECUTE FUNCTION qaqc.set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON qc_lots
    FOR EACH ROW EXECUTE FUNCTION qaqc.set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON calibrator_lots
    FOR EACH ROW EXECUTE FUNCTION qaqc.set_updated_at();

-- Set the role password from psql using \password pjqaqc_app, then enable LOGIN.
CREATE ROLE pjqaqc_app NOLOGIN;
GRANT USAGE ON SCHEMA qaqc TO pjqaqc_app;
REVOKE ALL ON ALL TABLES IN SCHEMA qaqc FROM PUBLIC;
REVOKE ALL ON FUNCTION qaqc.set_updated_at() FROM PUBLIC;
GRANT SELECT ON ALL TABLES IN SCHEMA qaqc TO pjqaqc_app;
GRANT INSERT, UPDATE ON
    lab_sections, instruments, specimen_types, test_items, instrument_assays,
    reagent_products, qc_products, calibrator_products,
    reagent_lots, qc_lots, calibrator_lots, qc_target_values, instrument_reagent_loads
TO pjqaqc_app;
GRANT INSERT, DELETE ON
    assay_reagent_requirements, assay_qc_requirements, assay_calibrator_requirements
TO pjqaqc_app;
GRANT INSERT ON
    qc_runs, qc_results, qc_result_reagents,
    calibration_events, calibration_event_assays, calibration_event_reagents
TO pjqaqc_app;
GRANT DELETE ON
    lab_sections, instruments, specimen_types, test_items, instrument_assays,
    reagent_products, qc_products, calibrator_products,
    reagent_lots, qc_lots, calibrator_lots, qc_target_values
TO pjqaqc_app;
COMMIT;
