-- ============================================================================
-- Laboratory QA/QC reference schema for MySQL 8.0.16+
-- Database: laboratory_qaqc
--
-- WARNING: this initialization script drops the objects listed below.
-- Do not run it against a production database without a verified backup.
-- All application timestamps should be written/read as UTC.
-- ============================================================================

CREATE DATABASE IF NOT EXISTS laboratory_qaqc
    CHARACTER SET utf8mb4
    COLLATE utf8mb4_0900_ai_ci;

USE laboratory_qaqc;
SET NAMES utf8mb4;

DROP VIEW IF EXISTS v_qc_result_detail;
DROP VIEW IF EXISTS v_assay_catalog;

SET FOREIGN_KEY_CHECKS = 0;
DROP TABLE IF EXISTS calibration_event_reagents;
DROP TABLE IF EXISTS calibration_event_assays;
DROP TABLE IF EXISTS calibration_events;
DROP TABLE IF EXISTS qc_result_reagents;
DROP TABLE IF EXISTS qc_results;
DROP TABLE IF EXISTS qc_runs;
DROP TABLE IF EXISTS instrument_reagent_loads;
DROP TABLE IF EXISTS qc_target_values;
DROP TABLE IF EXISTS calibrator_lots;
DROP TABLE IF EXISTS qc_lots;
DROP TABLE IF EXISTS reagent_lots;
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
SET FOREIGN_KEY_CHECKS = 1;

-- ==========================================================================
-- A. Reference/configuration layer
-- ==========================================================================

CREATE TABLE lab_sections (
    section_id      BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    section_code    VARCHAR(30) NOT NULL,
    section_name    VARCHAR(100) NOT NULL,
    description     VARCHAR(500) NULL,
    active          BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at      DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
                                  ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (section_id),
    UNIQUE KEY uq_lab_sections_code (section_code)
) ENGINE=InnoDB;

CREATE TABLE instruments (
    instrument_id   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    section_id      BIGINT UNSIGNED NOT NULL,
    serial_number   VARCHAR(100) NOT NULL,
    instrument_name VARCHAR(150) NOT NULL,
    manufacturer    VARCHAR(150) NULL,
    model_name      VARCHAR(100) NULL,
    instrument_role VARCHAR(20) NOT NULL DEFAULT 'PRIMARY',
    active          BOOLEAN NOT NULL DEFAULT TRUE,
    installed_at    DATE NULL,
    retired_at      DATE NULL,
    created_at      DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at      DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
                                  ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (instrument_id),
    UNIQUE KEY uq_instruments_serial (serial_number),
    KEY idx_instruments_section_active (section_id, active),
    CONSTRAINT chk_instruments_role
        CHECK (instrument_role IN ('PRIMARY', 'BACKUP', 'OTHER')),
    CONSTRAINT chk_instruments_dates
        CHECK (retired_at IS NULL OR installed_at IS NULL OR retired_at >= installed_at),
    CONSTRAINT fk_instruments_section
        FOREIGN KEY (section_id) REFERENCES lab_sections(section_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE specimen_types (
    specimen_type_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    specimen_code    VARCHAR(30) NOT NULL,
    specimen_name    VARCHAR(100) NOT NULL,
    description      VARCHAR(500) NULL,
    active           BOOLEAN NOT NULL DEFAULT TRUE,
    created_at       DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at       DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
                                   ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (specimen_type_id),
    UNIQUE KEY uq_specimen_types_code (specimen_code)
) ENGINE=InnoDB;

CREATE TABLE test_items (
    test_item_id     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    item_code        VARCHAR(50) NOT NULL,
    item_name        VARCHAR(150) NOT NULL,
    loinc_code       VARCHAR(30) NULL,
    default_unit     VARCHAR(50) NULL,
    description      VARCHAR(500) NULL,
    active           BOOLEAN NOT NULL DEFAULT TRUE,
    created_at       DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at       DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
                                   ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (test_item_id),
    UNIQUE KEY uq_test_items_code (item_code),
    KEY idx_test_items_name (item_name)
) ENGINE=InnoDB;

-- The central configuration row. The same GLU item on BLOOD and URINE is two
-- assays, and GLU on two instruments is also two assays.
CREATE TABLE instrument_assays (
    assay_id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    instrument_id     BIGINT UNSIGNED NOT NULL,
    test_item_id      BIGINT UNSIGNED NOT NULL,
    specimen_type_id  BIGINT UNSIGNED NOT NULL,
    instrument_test_code VARCHAR(80) NULL,
    method_name       VARCHAR(150) NULL,
    result_unit       VARCHAR(50) NULL,
    decimal_places    TINYINT UNSIGNED NOT NULL DEFAULT 2,
    active            BOOLEAN NOT NULL DEFAULT TRUE,
    valid_from        DATE NULL,
    valid_to          DATE NULL,
    created_at        DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at        DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
                                    ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (assay_id),
    UNIQUE KEY uq_assay_route (instrument_id, test_item_id, specimen_type_id),
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
) ENGINE=InnoDB;

CREATE TABLE reagent_products (
    reagent_product_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    product_code       VARCHAR(60) NOT NULL,
    product_name       VARCHAR(180) NOT NULL,
    manufacturer       VARCHAR(150) NULL,
    catalog_number     VARCHAR(100) NULL,
    storage_condition  VARCHAR(255) NULL,
    active             BOOLEAN NOT NULL DEFAULT TRUE,
    created_at         DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at         DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
                                     ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (reagent_product_id),
    UNIQUE KEY uq_reagent_products_code (product_code),
    KEY idx_reagent_products_name (product_name)
) ENGINE=InnoDB;

CREATE TABLE qc_products (
    qc_product_id      BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    product_code       VARCHAR(60) NOT NULL,
    product_name       VARCHAR(180) NOT NULL,
    manufacturer       VARCHAR(150) NULL,
    catalog_number     VARCHAR(100) NULL,
    matrix_description VARCHAR(255) NULL,
    storage_condition  VARCHAR(255) NULL,
    active             BOOLEAN NOT NULL DEFAULT TRUE,
    created_at         DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at         DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
                                     ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (qc_product_id),
    UNIQUE KEY uq_qc_products_code (product_code),
    KEY idx_qc_products_name (product_name)
) ENGINE=InnoDB;

CREATE TABLE calibrator_products (
    calibrator_product_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    product_code          VARCHAR(60) NOT NULL,
    product_name          VARCHAR(180) NOT NULL,
    manufacturer          VARCHAR(150) NULL,
    catalog_number        VARCHAR(100) NULL,
    matrix_description    VARCHAR(255) NULL,
    storage_condition     VARCHAR(255) NULL,
    active                BOOLEAN NOT NULL DEFAULT TRUE,
    created_at            DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at            DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
                                        ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (calibrator_product_id),
    UNIQUE KEY uq_calibrator_products_code (product_code),
    KEY idx_calibrator_products_name (product_name)
) ENGINE=InnoDB;

-- N:M: many assays may use the same reagent product, and an assay may require
-- several reagent products (main reagent, diluent, wash solution, etc.).
CREATE TABLE assay_reagent_requirements (
    assay_id          BIGINT UNSIGNED NOT NULL,
    reagent_product_id BIGINT UNSIGNED NOT NULL,
    reagent_role      VARCHAR(30) NOT NULL DEFAULT 'PRIMARY',
    required          BOOLEAN NOT NULL DEFAULT TRUE,
    priority          SMALLINT UNSIGNED NOT NULL DEFAULT 1,
    note              VARCHAR(500) NULL,
    created_at        DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (assay_id, reagent_product_id, reagent_role),
    KEY idx_arr_product_assay (reagent_product_id, assay_id),
    CONSTRAINT chk_arr_role
        CHECK (reagent_role IN ('PRIMARY', 'AUXILIARY', 'DILUENT', 'WASH', 'OTHER')),
    CONSTRAINT fk_arr_assay
        FOREIGN KEY (assay_id) REFERENCES instrument_assays(assay_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_arr_product
        FOREIGN KEY (reagent_product_id) REFERENCES reagent_products(reagent_product_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
) ENGINE=InnoDB;

-- N:M: one multi-analyte QC product can cover many assays.
CREATE TABLE assay_qc_requirements (
    assay_id          BIGINT UNSIGNED NOT NULL,
    qc_product_id     BIGINT UNSIGNED NOT NULL,
    required          BOOLEAN NOT NULL DEFAULT TRUE,
    priority          SMALLINT UNSIGNED NOT NULL DEFAULT 1,
    note              VARCHAR(500) NULL,
    created_at        DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (assay_id, qc_product_id),
    KEY idx_aqr_product_assay (qc_product_id, assay_id),
    CONSTRAINT fk_aqr_assay
        FOREIGN KEY (assay_id) REFERENCES instrument_assays(assay_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_aqr_product
        FOREIGN KEY (qc_product_id) REFERENCES qc_products(qc_product_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
) ENGINE=InnoDB;

-- N:M: one multi-analyte calibrator can calibrate many assays.
CREATE TABLE assay_calibrator_requirements (
    assay_id             BIGINT UNSIGNED NOT NULL,
    calibrator_product_id BIGINT UNSIGNED NOT NULL,
    required             BOOLEAN NOT NULL DEFAULT TRUE,
    priority             SMALLINT UNSIGNED NOT NULL DEFAULT 1,
    note                 VARCHAR(500) NULL,
    created_at           DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (assay_id, calibrator_product_id),
    KEY idx_acr_product_assay (calibrator_product_id, assay_id),
    CONSTRAINT fk_acr_assay
        FOREIGN KEY (assay_id) REFERENCES instrument_assays(assay_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_acr_product
        FOREIGN KEY (calibrator_product_id)
        REFERENCES calibrator_products(calibrator_product_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
) ENGINE=InnoDB;

-- ==========================================================================
-- B. Lot/inventory layer: real, traceable material instances
-- ==========================================================================

CREATE TABLE reagent_lots (
    reagent_lot_id    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    reagent_product_id BIGINT UNSIGNED NOT NULL,
    lot_number        VARCHAR(100) NOT NULL,
    received_at       DATE NULL,
    opened_at         DATETIME(6) NULL,
    expiry_date       DATE NULL,
    quantity_received DECIMAL(14,3) NULL,
    quantity_unit     VARCHAR(30) NULL,
    lot_status        VARCHAR(20) NOT NULL DEFAULT 'AVAILABLE',
    certificate_uri   VARCHAR(500) NULL,
    created_at        DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at        DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
                                    ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (reagent_lot_id),
    UNIQUE KEY uq_reagent_lot (reagent_product_id, lot_number),
    UNIQUE KEY uq_reagent_lot_product (reagent_lot_id, reagent_product_id),
    KEY idx_reagent_lots_expiry_status (expiry_date, lot_status),
    CONSTRAINT chk_reagent_lots_status
        CHECK (lot_status IN ('QUARANTINE', 'AVAILABLE', 'IN_USE', 'EXHAUSTED', 'EXPIRED', 'RECALLED')),
    CONSTRAINT chk_reagent_lots_dates
        CHECK (expiry_date IS NULL OR received_at IS NULL OR expiry_date >= received_at),
    CONSTRAINT fk_reagent_lots_product
        FOREIGN KEY (reagent_product_id) REFERENCES reagent_products(reagent_product_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
) ENGINE=InnoDB;

-- A QC kit lot may contain several levels. Each level is one physical lot row.
CREATE TABLE qc_lots (
    qc_lot_id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    qc_product_id     BIGINT UNSIGNED NOT NULL,
    lot_number        VARCHAR(100) NOT NULL,
    level_code        VARCHAR(30) NOT NULL,
    received_at       DATE NULL,
    opened_at         DATETIME(6) NULL,
    expiry_date       DATE NULL,
    lot_status        VARCHAR(20) NOT NULL DEFAULT 'AVAILABLE',
    certificate_uri   VARCHAR(500) NULL,
    created_at        DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at        DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
                                    ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (qc_lot_id),
    UNIQUE KEY uq_qc_lot_level (qc_product_id, lot_number, level_code),
    UNIQUE KEY uq_qc_lot_product (qc_lot_id, qc_product_id),
    KEY idx_qc_lots_expiry_status (expiry_date, lot_status),
    CONSTRAINT chk_qc_lots_status
        CHECK (lot_status IN ('QUARANTINE', 'AVAILABLE', 'IN_USE', 'EXHAUSTED', 'EXPIRED', 'RECALLED')),
    CONSTRAINT chk_qc_lots_dates
        CHECK (expiry_date IS NULL OR received_at IS NULL OR expiry_date >= received_at),
    CONSTRAINT fk_qc_lots_product
        FOREIGN KEY (qc_product_id) REFERENCES qc_products(qc_product_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE calibrator_lots (
    calibrator_lot_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    calibrator_product_id BIGINT UNSIGNED NOT NULL,
    lot_number        VARCHAR(100) NOT NULL,
    level_code        VARCHAR(30) NOT NULL DEFAULT 'DEFAULT',
    assigned_value_text VARCHAR(500) NULL,
    received_at       DATE NULL,
    opened_at         DATETIME(6) NULL,
    expiry_date       DATE NULL,
    lot_status        VARCHAR(20) NOT NULL DEFAULT 'AVAILABLE',
    certificate_uri   VARCHAR(500) NULL,
    created_at        DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at        DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
                                    ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (calibrator_lot_id),
    UNIQUE KEY uq_calibrator_lot_level
        (calibrator_product_id, lot_number, level_code),
    UNIQUE KEY uq_calibrator_lot_product
        (calibrator_lot_id, calibrator_product_id),
    KEY idx_calibrator_lots_expiry_status (expiry_date, lot_status),
    CONSTRAINT chk_calibrator_lots_status
        CHECK (lot_status IN ('QUARANTINE', 'AVAILABLE', 'IN_USE', 'EXHAUSTED', 'EXPIRED', 'RECALLED')),
    CONSTRAINT chk_calibrator_lots_dates
        CHECK (expiry_date IS NULL OR received_at IS NULL OR expiry_date >= received_at),
    CONSTRAINT fk_calibrator_lots_product
        FOREIGN KEY (calibrator_product_id)
        REFERENCES calibrator_products(calibrator_product_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
) ENGINE=InnoDB;

-- Target mean/SD is specific to assay + QC lot/level and is versioned.
-- target_mean/SD are copied into qc_results at measurement time for auditability.
CREATE TABLE qc_target_values (
    qc_target_id      BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    assay_id          BIGINT UNSIGNED NOT NULL,
    qc_lot_id         BIGINT UNSIGNED NOT NULL,
    qc_product_id     BIGINT UNSIGNED NOT NULL,
    target_source     VARCHAR(20) NOT NULL,
    target_mean       DECIMAL(18,6) NOT NULL,
    target_sd         DECIMAL(18,6) NOT NULL,
    acceptable_low    DECIMAL(18,6) NULL,
    acceptable_high   DECIMAL(18,6) NULL,
    effective_from    DATETIME(6) NOT NULL,
    effective_to      DATETIME(6) NULL,
    approved_by       VARCHAR(100) NULL,
    approved_at       DATETIME(6) NULL,
    note              VARCHAR(500) NULL,
    current_slot      TINYINT GENERATED ALWAYS AS
                      (CASE WHEN effective_to IS NULL THEN 1 ELSE NULL END) STORED,
    created_at        DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (qc_target_id),
    UNIQUE KEY uq_qc_target_version (assay_id, qc_lot_id, effective_from),
    UNIQUE KEY uq_qc_target_current (assay_id, qc_lot_id, current_slot),
    UNIQUE KEY uq_qc_target_identity
        (qc_target_id, assay_id, qc_lot_id, qc_product_id),
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
    CONSTRAINT fk_qc_target_requirement
        FOREIGN KEY (assay_id, qc_product_id)
        REFERENCES assay_qc_requirements(assay_id, qc_product_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE instrument_reagent_loads (
    reagent_load_id   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    instrument_id     BIGINT UNSIGNED NOT NULL,
    reagent_lot_id    BIGINT UNSIGNED NOT NULL,
    position_code     VARCHAR(50) NOT NULL,
    loaded_at         DATETIME(6) NOT NULL,
    unloaded_at       DATETIME(6) NULL,
    loaded_by         VARCHAR(100) NULL,
    unloaded_by       VARCHAR(100) NULL,
    current_slot      TINYINT GENERATED ALWAYS AS
                      (CASE WHEN unloaded_at IS NULL THEN 1 ELSE NULL END) STORED,
    note              VARCHAR(500) NULL,
    created_at        DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (reagent_load_id),
    UNIQUE KEY uq_current_instrument_position
        (instrument_id, position_code, current_slot),
    KEY idx_reagent_load_lot_time (reagent_lot_id, loaded_at),
    CONSTRAINT chk_reagent_load_dates
        CHECK (unloaded_at IS NULL OR unloaded_at >= loaded_at),
    CONSTRAINT fk_reagent_load_instrument
        FOREIGN KEY (instrument_id) REFERENCES instruments(instrument_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_reagent_load_lot
        FOREIGN KEY (reagent_lot_id) REFERENCES reagent_lots(reagent_lot_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
) ENGINE=InnoDB;

-- ==========================================================================
-- C. Transaction/audit layer
-- ==========================================================================

-- One physical QC vial/run can yield several analyte results.
CREATE TABLE qc_runs (
    qc_run_id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    instrument_id     BIGINT UNSIGNED NOT NULL,
    qc_lot_id         BIGINT UNSIGNED NOT NULL,
    qc_product_id     BIGINT UNSIGNED NOT NULL,
    run_at            DATETIME(6) NOT NULL,
    operator_id       VARCHAR(100) NULL,
    instrument_run_id VARCHAR(120) NULL,
    run_status        VARCHAR(20) NOT NULL DEFAULT 'COMPLETED',
    note              VARCHAR(1000) NULL,
    created_at        DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (qc_run_id),
    UNIQUE KEY uq_qc_run_instrument_ref (instrument_id, instrument_run_id),
    UNIQUE KEY uq_qc_run_identity
        (qc_run_id, instrument_id, qc_lot_id, qc_product_id),
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
) ENGINE=InnoDB;

CREATE TABLE qc_results (
    qc_result_id      BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    qc_run_id         BIGINT UNSIGNED NOT NULL,
    instrument_id     BIGINT UNSIGNED NOT NULL,
    assay_id          BIGINT UNSIGNED NOT NULL,
    qc_lot_id         BIGINT UNSIGNED NOT NULL,
    qc_product_id     BIGINT UNSIGNED NOT NULL,
    qc_target_id      BIGINT UNSIGNED NULL,
    result_value      DECIMAL(18,6) NOT NULL,
    unit_snapshot     VARCHAR(50) NULL,
    target_mean_snapshot DECIMAL(18,6) NULL,
    target_sd_snapshot   DECIMAL(18,6) NULL,
    z_score           DECIMAL(18,6) GENERATED ALWAYS AS
                      ((result_value - target_mean_snapshot)
                       / NULLIF(target_sd_snapshot, 0)) STORED,
    result_status     VARCHAR(20) NOT NULL DEFAULT 'PASS',
    westgard_flags    JSON NULL,
    reviewed_by       VARCHAR(100) NULL,
    reviewed_at       DATETIME(6) NULL,
    note              VARCHAR(1000) NULL,
    created_at        DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (qc_result_id),
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
        REFERENCES qc_target_values
            (qc_target_id, assay_id, qc_lot_id, qc_product_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
) ENGINE=InnoDB;

-- Records the actual reagent lot(s) that contributed to each QC result.
CREATE TABLE qc_result_reagents (
    qc_result_id      BIGINT UNSIGNED NOT NULL,
    assay_id          BIGINT UNSIGNED NOT NULL,
    reagent_lot_id    BIGINT UNSIGNED NOT NULL,
    reagent_product_id BIGINT UNSIGNED NOT NULL,
    reagent_role      VARCHAR(30) NOT NULL DEFAULT 'PRIMARY',
    created_at        DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (qc_result_id, reagent_lot_id, reagent_role),
    KEY idx_qrr_lot_result (reagent_lot_id, qc_result_id),
    CONSTRAINT chk_qrr_role
        CHECK (reagent_role IN ('PRIMARY', 'AUXILIARY', 'DILUENT', 'WASH', 'OTHER')),
    CONSTRAINT fk_qrr_result_assay
        FOREIGN KEY (qc_result_id, assay_id)
        REFERENCES qc_results(qc_result_id, assay_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_qrr_lot_product
        FOREIGN KEY (reagent_lot_id, reagent_product_id)
        REFERENCES reagent_lots(reagent_lot_id, reagent_product_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_qrr_requirement
        FOREIGN KEY (assay_id, reagent_product_id, reagent_role)
        REFERENCES assay_reagent_requirements
            (assay_id, reagent_product_id, reagent_role)
        ON UPDATE RESTRICT ON DELETE RESTRICT
) ENGINE=InnoDB;

-- A single calibration event may calibrate several assays.
CREATE TABLE calibration_events (
    calibration_event_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    instrument_id        BIGINT UNSIGNED NOT NULL,
    calibrator_lot_id    BIGINT UNSIGNED NOT NULL,
    calibrator_product_id BIGINT UNSIGNED NOT NULL,
    performed_at         DATETIME(6) NOT NULL,
    operator_id          VARCHAR(100) NULL,
    calibration_reason   VARCHAR(30) NOT NULL DEFAULT 'SCHEDULED',
    event_status         VARCHAR(20) NOT NULL,
    instrument_event_id  VARCHAR(120) NULL,
    raw_data_uri         VARCHAR(500) NULL,
    note                 VARCHAR(1000) NULL,
    created_at           DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (calibration_event_id),
    UNIQUE KEY uq_cal_event_instrument_ref (instrument_id, instrument_event_id),
    UNIQUE KEY uq_cal_event_identity
        (calibration_event_id, instrument_id, calibrator_product_id),
    KEY idx_cal_event_instrument_time (instrument_id, performed_at),
    KEY idx_cal_event_lot_time (calibrator_lot_id, performed_at),
    CONSTRAINT chk_cal_event_reason
        CHECK (calibration_reason IN ('SCHEDULED', 'NEW_LOT', 'QC_FAILURE', 'MAINTENANCE', 'OTHER')),
    CONSTRAINT chk_cal_event_status
        CHECK (event_status IN ('PASS', 'FAIL', 'CANCELLED')),
    CONSTRAINT fk_cal_event_instrument
        FOREIGN KEY (instrument_id) REFERENCES instruments(instrument_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_cal_event_lot_product
        FOREIGN KEY (calibrator_lot_id, calibrator_product_id)
        REFERENCES calibrator_lots(calibrator_lot_id, calibrator_product_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE calibration_event_assays (
    calibration_event_id BIGINT UNSIGNED NOT NULL,
    instrument_id        BIGINT UNSIGNED NOT NULL,
    assay_id             BIGINT UNSIGNED NOT NULL,
    calibrator_product_id BIGINT UNSIGNED NOT NULL,
    assay_status         VARCHAR(20) NOT NULL,
    pre_bias             DECIMAL(18,6) NULL,
    post_bias            DECIMAL(18,6) NULL,
    note                 VARCHAR(500) NULL,
    created_at           DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (calibration_event_id, assay_id),
    KEY idx_cea_assay_event (assay_id, calibration_event_id),
    CONSTRAINT chk_cea_status
        CHECK (assay_status IN ('PASS', 'FAIL', 'NOT_EVALUATED')),
    CONSTRAINT fk_cea_event_identity
        FOREIGN KEY (calibration_event_id, instrument_id, calibrator_product_id)
        REFERENCES calibration_events
            (calibration_event_id, instrument_id, calibrator_product_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_cea_assay_instrument
        FOREIGN KEY (assay_id, instrument_id)
        REFERENCES instrument_assays(assay_id, instrument_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_cea_calibrator_requirement
        FOREIGN KEY (assay_id, calibrator_product_id)
        REFERENCES assay_calibrator_requirements
            (assay_id, calibrator_product_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE calibration_event_reagents (
    calibration_event_id BIGINT UNSIGNED NOT NULL,
    assay_id              BIGINT UNSIGNED NOT NULL,
    reagent_lot_id       BIGINT UNSIGNED NOT NULL,
    reagent_product_id   BIGINT UNSIGNED NOT NULL,
    reagent_role         VARCHAR(30) NOT NULL DEFAULT 'PRIMARY',
    created_at           DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (calibration_event_id, assay_id, reagent_lot_id, reagent_role),
    KEY idx_cer_lot_event (reagent_lot_id, calibration_event_id),
    CONSTRAINT chk_cer_role
        CHECK (reagent_role IN ('PRIMARY', 'AUXILIARY', 'DILUENT', 'WASH', 'OTHER')),
    CONSTRAINT fk_cer_event_assay
        FOREIGN KEY (calibration_event_id, assay_id)
        REFERENCES calibration_event_assays(calibration_event_id, assay_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_cer_lot_product
        FOREIGN KEY (reagent_lot_id, reagent_product_id)
        REFERENCES reagent_lots(reagent_lot_id, reagent_product_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_cer_requirement
        FOREIGN KEY (assay_id, reagent_product_id, reagent_role)
        REFERENCES assay_reagent_requirements
            (assay_id, reagent_product_id, reagent_role)
        ON UPDATE RESTRICT ON DELETE RESTRICT
) ENGINE=InnoDB;

-- ==========================================================================
-- D. Read views
-- ==========================================================================

CREATE VIEW v_assay_catalog AS
SELECT
    a.assay_id,
    s.section_code,
    s.section_name,
    i.instrument_id,
    i.serial_number,
    i.instrument_name,
    t.test_item_id,
    t.item_code,
    t.item_name,
    sp.specimen_type_id,
    sp.specimen_code,
    sp.specimen_name,
    a.method_name,
    COALESCE(a.result_unit, t.default_unit) AS result_unit,
    a.active
FROM instrument_assays AS a
JOIN instruments AS i ON i.instrument_id = a.instrument_id
JOIN lab_sections AS s ON s.section_id = i.section_id
JOIN test_items AS t ON t.test_item_id = a.test_item_id
JOIN specimen_types AS sp ON sp.specimen_type_id = a.specimen_type_id;

CREATE VIEW v_qc_result_detail AS
SELECT
    qr.qc_result_id,
    qrun.run_at,
    qrun.instrument_run_id,
    vac.section_code,
    vac.serial_number,
    vac.instrument_name,
    vac.item_code,
    vac.item_name,
    vac.specimen_code,
    vac.specimen_name,
    qp.product_code AS qc_product_code,
    qp.product_name AS qc_product_name,
    ql.lot_number AS qc_lot_number,
    ql.level_code AS qc_level,
    qr.result_value,
    qr.unit_snapshot,
    qr.target_mean_snapshot,
    qr.target_sd_snapshot,
    qr.z_score,
    qr.result_status,
    qr.westgard_flags,
    qr.reviewed_by,
    qr.reviewed_at
FROM qc_results AS qr
JOIN qc_runs AS qrun ON qrun.qc_run_id = qr.qc_run_id
JOIN v_assay_catalog AS vac ON vac.assay_id = qr.assay_id
JOIN qc_lots AS ql ON ql.qc_lot_id = qrun.qc_lot_id
JOIN qc_products AS qp ON qp.qc_product_id = ql.qc_product_id;

-- ==========================================================================
-- E. Minimal reference seed data
-- ==========================================================================

INSERT INTO specimen_types (specimen_code, specimen_name, description) VALUES
    ('BLOOD', 'Blood', 'Whole blood, serum, or plasma; refine further if workflow requires it'),
    ('URINE', 'Urine', 'Urine specimen'),
    ('CSF',   'Cerebrospinal fluid', 'CSF specimen');

INSERT INTO lab_sections (section_code, section_name) VALUES
    ('CHEM', 'Clinical Chemistry'),
    ('HEMA', 'Hematology'),
    ('IMM',  'Immunology'),
    ('MICRO','Microbiology'),
    ('BBANK','Blood Bank');

-- End of initialization script.
