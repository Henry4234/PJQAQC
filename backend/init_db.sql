-- PJQAQC MySQL 資料庫初始化腳本
-- 用法: mysql -h 192.168.0.111 -u PJQAQC -p PJQAQC < init_db.sql

CREATE DATABASE IF NOT EXISTS PJQAQC
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE PJQAQC;

-- 儀器主檔
CREATE TABLE IF NOT EXISTS instruments (
    serial_number  VARCHAR(100) NOT NULL PRIMARY KEY,
    instrument_name VARCHAR(200) NOT NULL,
    lab_group      VARCHAR(50)  NOT NULL
                   COMMENT '組別: 生化免疫組 / 血液組 / 鏡檢組 / 血庫組',
    machine_role   VARCHAR(20)  NOT NULL DEFAULT '主機'
                   COMMENT '主機 / 備機',
    department     VARCHAR(100) NULL,
    active         BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 品管紀錄
CREATE TABLE IF NOT EXISTS qc_records (
    id                        BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
    instrument_name           VARCHAR(200) NOT NULL,
    instrument_serial_number  VARCHAR(100) NOT NULL,
    department                VARCHAR(100) NULL,
    qc_date                   DATE         NOT NULL,
    qc_time                   TIME         NOT NULL,
    operator                  VARCHAR(100) NULL,
    test_item                 VARCHAR(100) NOT NULL,
    test_item_full_name       VARCHAR(200) NULL,
    qc_level                  VARCHAR(50)  NULL,
    qc_lot_number             VARCHAR(100) NULL,
    qc_result_value           DECIMAL(15,4) NULL,
    unit                      VARCHAR(50)  NULL,
    lot_mean                  DECIMAL(15,4) NULL,
    lot_standard_deviation    DECIMAL(15,6) NULL,
    acceptable_range_lower    DECIMAL(15,4) NULL,
    acceptable_range_upper    DECIMAL(15,4) NULL,
    z_score                   DECIMAL(10,2) NULL,
    qc_status                 VARCHAR(20)  NOT NULL DEFAULT 'Pass'
                              COMMENT 'Pass / Warning / Fail',
    westgard_rule_violation   TEXT         NULL,
    remark                    TEXT         NULL,
    created_at                DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

    INDEX idx_qc_date (qc_date),
    INDEX idx_instrument_sn (instrument_serial_number),
    INDEX idx_test_item (test_item),
    INDEX idx_sn_item_level (instrument_serial_number, test_item, qc_level),

    CONSTRAINT fk_qc_records_instrument
        FOREIGN KEY (instrument_serial_number) REFERENCES instruments(serial_number)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
