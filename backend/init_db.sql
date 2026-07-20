-- =============================================================
-- PJQAQC MySQL / MariaDB 資料庫初始化腳本 (v2 關聯式重構)
-- 用法: mysql -h 192.168.0.111 -u PJQAQC -p PJQAQC < init_db.sql
--
-- 架構關聯流向:
--   lab_group (組別) → instruments (儀器) → reagent_qc (品管) → reagent (試劑) → items (項目)
--   主檔皆以 UUID 為主鍵。多對多關係:
--     品管 (reagent_qc)  N─M  試劑 (reagent)        → 透過 qc_reagent_map
--     試劑 (reagent)     N─M  項目 (items)          → 透過 reagent_item_map
--     試劑 (reagent)     N─M  檢體 (specimen_type)  → 透過 reagent_specimen_map
--   一對多關係:
--     儀器 1─N 試劑 (reagent.instrument_serial_number)
--     儀器 1─N 項目 (items.instrument_serial_number)
--     檢體 1─N 品管液 (reagent_qc.specimen_type_id；同一項目不同檢體用不同品管液)
-- =============================================================

SET FOREIGN_KEY_CHECKS = 0;
DROP TABLE IF EXISTS qc_records;
DROP TABLE IF EXISTS qc_reagent_map;
DROP TABLE IF EXISTS reagent_item_map;
DROP TABLE IF EXISTS reagent_specimen_map;
DROP TABLE IF EXISTS reagent_qc;
DROP TABLE IF EXISTS items;
DROP TABLE IF EXISTS reagent;
DROP TABLE IF EXISTS specimen_type;
DROP TABLE IF EXISTS instruments;
DROP TABLE IF EXISTS lab_group;
SET FOREIGN_KEY_CHECKS = 1;

-- 註：資料庫欄位說明改以本地 Markdown 檔維護，見 schema_readme.md


-- -------------------------------------------------------------
-- 1. lab_group : 組別主檔 (UUID PK)
-- -------------------------------------------------------------
CREATE TABLE lab_group (
    group_id    CHAR(36)     NOT NULL DEFAULT UUID() PRIMARY KEY,
    group_name  VARCHAR(50)  NOT NULL UNIQUE COMMENT '組別名稱，例如 生化免疫組 / 血液組 / 鏡檢組 / 血庫組',
    group_code  VARCHAR(20)  NULL           COMMENT '組別代碼 (選填)',
    description VARCHAR(255) NULL,
    active      BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- -------------------------------------------------------------
-- 2. instruments : 儀器主檔 (組別改為 FK 關聯 lab_group)
-- -------------------------------------------------------------
CREATE TABLE instruments (
    serial_number   VARCHAR(100) NOT NULL PRIMARY KEY COMMENT '儀器序號 S/N',
    instrument_name VARCHAR(200) NOT NULL,
    group_id        CHAR(36)     NOT NULL COMMENT 'FK → lab_group.group_id (組別由此關聯查詢)',
    machine_role    VARCHAR(20)  NOT NULL DEFAULT '主機' COMMENT '主機 / 備機',
    active          BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    INDEX idx_instruments_group (group_id),
    CONSTRAINT fk_instruments_group
        FOREIGN KEY (group_id) REFERENCES lab_group(group_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- -------------------------------------------------------------
-- 3. items : 檢驗項目主檔 (UUID PK)
--    管理每台儀器上的所有檢驗項目 (RBC / HGB / WBC ...)。
--    一台儀器有多個項目 (1─N)；同一 item_code 在不同儀器各自成列。
-- -------------------------------------------------------------
CREATE TABLE items (
    item_id                  CHAR(36)     NOT NULL DEFAULT UUID() PRIMARY KEY,
    instrument_serial_number VARCHAR(100) NOT NULL COMMENT 'FK → instruments.serial_number (此項目屬於哪台儀器)',
    group_id                 CHAR(36)     NULL COMMENT 'FK → lab_group.group_id',
    item_code                VARCHAR(50)  NOT NULL COMMENT '項目代碼，如 RBC / HGB / WBC / NEUT%',
    item_name                VARCHAR(200) NULL COMMENT '項目全名',
    unit                     VARCHAR(50)  NULL,
    sort_order               INT          NOT NULL DEFAULT 0,
    active                   BOOLEAN      NOT NULL DEFAULT TRUE,
    remark                   TEXT         NULL,
    created_at               DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at               DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    UNIQUE KEY uq_items_instrument_code (instrument_serial_number, item_code),
    INDEX idx_items_group (group_id),
    CONSTRAINT fk_items_instrument
        FOREIGN KEY (instrument_serial_number) REFERENCES instruments(serial_number),
    CONSTRAINT fk_items_group
        FOREIGN KEY (group_id) REFERENCES lab_group(group_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- -------------------------------------------------------------
-- 4. specimen_type : 檢體類別主檔 (UUID PK，固定清單 lookup)
--    如 BLOOD(B) / URINE(U) / CSF(CSF)。
--    試劑可操作的檢體為多對多 (reagent_specimen_map)；
--    品管液則各針對一種檢體 (reagent_qc.specimen_type_id)。
-- -------------------------------------------------------------
CREATE TABLE specimen_type (
    specimen_type_id CHAR(36)     NOT NULL DEFAULT UUID() PRIMARY KEY,
    code             VARCHAR(20)  NOT NULL UNIQUE COMMENT '檢體代碼，如 B / U / CSF',
    name             VARCHAR(100) NOT NULL COMMENT '檢體名稱，如 BLOOD / URINE / CSF',
    description      VARCHAR(255) NULL,
    active           BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- -------------------------------------------------------------
-- 5. reagent : 試劑主檔 (UUID PK)
--    管理試劑入庫、試劑平測、批號延續性
-- -------------------------------------------------------------
CREATE TABLE reagent (
    reagent_id               CHAR(36)     NOT NULL DEFAULT UUID() PRIMARY KEY,
    group_id                 CHAR(36)     NULL COMMENT 'FK → lab_group.group_id',
    instrument_serial_number VARCHAR(100) NULL COMMENT 'FK → instruments.serial_number (此試劑用於哪台儀器)',
    test_item                VARCHAR(100) NOT NULL COMMENT '對應檢驗項目，如 GLU / WBC',
    reagent_name             VARCHAR(200) NOT NULL,
    lot_number               VARCHAR(100) NOT NULL COMMENT '試劑批號',
    manufacturer             VARCHAR(200) NULL,

    in_stock                 BOOLEAN      NOT NULL DEFAULT FALSE COMMENT '是否已入庫',
    in_stock_date            DATE         NULL     COMMENT '入庫日期',

    parallel_test_done       BOOLEAN      NOT NULL DEFAULT FALSE COMMENT '入庫後是否已完成試劑平行測試 (平測)',
    parallel_test_date       DATE         NULL     COMMENT '試劑平測完成日期',

    same_lot_as_previous     BOOLEAN      NOT NULL DEFAULT FALSE COMMENT '是否與上一個批號為同一批號',
    previous_lot_number      VARCHAR(100) NULL     COMMENT '上一個批號 (供批號延續性追溯)',

    expiry_date              DATE         NULL     COMMENT '效期',
    active                   BOOLEAN      NOT NULL DEFAULT TRUE,
    remark                   TEXT         NULL,
    created_at               DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at               DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    INDEX idx_reagent_group (group_id),
    INDEX idx_reagent_instrument (instrument_serial_number),
    INDEX idx_reagent_item (test_item),
    INDEX idx_reagent_lot (lot_number),
    CONSTRAINT fk_reagent_group
        FOREIGN KEY (group_id) REFERENCES lab_group(group_id),
    CONSTRAINT fk_reagent_instrument
        FOREIGN KEY (instrument_serial_number) REFERENCES instruments(serial_number)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- -------------------------------------------------------------
-- 6. reagent_qc : 品管液主檔 (UUID PK)
--    品管液本身也是一種試劑，但具有不同濃度 (level)，
--    且需追蹤平行測試後的新 standard mean / SD。
--    「品管管理哪些試劑」為多對多，見 qc_reagent_map。
--    同一檢驗項目、不同檢體使用不同品管液，故各針對一種檢體
--    (specimen_type_id)，如 Na: Urine 用 Liquichek Urine Control、
--    BLOOD 用 PreciControl Clinchem Multi。
-- -------------------------------------------------------------
CREATE TABLE reagent_qc (
    reagent_qc_id            CHAR(36)     NOT NULL DEFAULT UUID() PRIMARY KEY,
    group_id                 CHAR(36)     NULL COMMENT 'FK → lab_group.group_id',
    instrument_serial_number VARCHAR(100) NULL COMMENT 'FK → instruments.serial_number',
    specimen_type_id         CHAR(36)     NULL COMMENT 'FK → specimen_type.specimen_type_id (此品管液針對的檢體類別)',

    test_item                VARCHAR(100) NOT NULL,
    test_item_full_name      VARCHAR(200) NULL,
    qc_level                 VARCHAR(50)  NOT NULL COMMENT '品管液濃度，如 Level 1 / Level 2 / Level 3',
    qc_lot_number            VARCHAR(100) NOT NULL COMMENT '品管液批號',
    unit                     VARCHAR(50)  NULL,

    manufacturer_mean        DECIMAL(15,4) NULL COMMENT '原廠 (或前批) 均值',
    manufacturer_sd          DECIMAL(15,6) NULL COMMENT '原廠 (或前批) SD',

    parallel_test_done       BOOLEAN      NOT NULL DEFAULT FALSE COMMENT '此品管液是否已完成平行測試',
    parallel_test_date       DATE         NULL     COMMENT '平行測試完成日期',
    new_standard_mean        DECIMAL(15,4) NULL COMMENT '平行測試後建立的新 standard mean',
    new_standard_sd          DECIMAL(15,6) NULL COMMENT '平行測試後建立的新 standard SD',

    in_use                   BOOLEAN      NOT NULL DEFAULT TRUE COMMENT '是否為目前使用中的品管液',
    active                   BOOLEAN      NOT NULL DEFAULT TRUE,
    remark                   TEXT         NULL,
    created_at               DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at               DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    INDEX idx_rqc_group (group_id),
    INDEX idx_rqc_instrument (instrument_serial_number),
    INDEX idx_rqc_item_level (test_item, qc_level),
    INDEX idx_rqc_lot (qc_lot_number),
    INDEX idx_rqc_specimen (specimen_type_id),
    CONSTRAINT fk_rqc_group
        FOREIGN KEY (group_id) REFERENCES lab_group(group_id),
    CONSTRAINT fk_rqc_instrument
        FOREIGN KEY (instrument_serial_number) REFERENCES instruments(serial_number),
    CONSTRAINT fk_rqc_specimen
        FOREIGN KEY (specimen_type_id) REFERENCES specimen_type(specimen_type_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- -------------------------------------------------------------
-- 7. reagent_specimen_map : 試劑 ↔ 檢體 關聯 (多對多)
--    同一種試劑可操作多種檢體，如 m-ALB 可驗 URINE 與 CSF。
-- -------------------------------------------------------------
CREATE TABLE reagent_specimen_map (
    id               BIGINT   NOT NULL AUTO_INCREMENT PRIMARY KEY,
    reagent_id       CHAR(36) NOT NULL COMMENT 'FK → reagent.reagent_id',
    specimen_type_id CHAR(36) NOT NULL COMMENT 'FK → specimen_type.specimen_type_id',
    created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    UNIQUE KEY uq_reagent_specimen (reagent_id, specimen_type_id),
    INDEX idx_rsmap_specimen (specimen_type_id),
    CONSTRAINT fk_rsmap_reagent
        FOREIGN KEY (reagent_id) REFERENCES reagent(reagent_id) ON DELETE CASCADE,
    CONSTRAINT fk_rsmap_specimen
        FOREIGN KEY (specimen_type_id) REFERENCES specimen_type(specimen_type_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- -------------------------------------------------------------
-- 8. qc_reagent_map : 品管 ↔ 試劑 關聯 (多對多)
--    一個品管 (reagent_qc) 可管理多種試劑；一個試劑亦可被多個品管涵蓋。
-- -------------------------------------------------------------
CREATE TABLE qc_reagent_map (
    id            BIGINT   NOT NULL AUTO_INCREMENT PRIMARY KEY,
    reagent_qc_id CHAR(36) NOT NULL COMMENT 'FK → reagent_qc.reagent_qc_id',
    reagent_id    CHAR(36) NOT NULL COMMENT 'FK → reagent.reagent_id',
    created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    UNIQUE KEY uq_qc_reagent (reagent_qc_id, reagent_id),
    INDEX idx_qcmap_reagent (reagent_id),
    CONSTRAINT fk_qcmap_rqc
        FOREIGN KEY (reagent_qc_id) REFERENCES reagent_qc(reagent_qc_id) ON DELETE CASCADE,
    CONSTRAINT fk_qcmap_reagent
        FOREIGN KEY (reagent_id) REFERENCES reagent(reagent_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- -------------------------------------------------------------
-- 9. reagent_item_map : 試劑 ↔ 項目 關聯 (多對多)
--    一個試劑可用於多個檢驗項目；一個項目亦可由多個試劑產生。
-- -------------------------------------------------------------
CREATE TABLE reagent_item_map (
    id         BIGINT   NOT NULL AUTO_INCREMENT PRIMARY KEY,
    reagent_id CHAR(36) NOT NULL COMMENT 'FK → reagent.reagent_id',
    item_id    CHAR(36) NOT NULL COMMENT 'FK → items.item_id',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    UNIQUE KEY uq_reagent_item (reagent_id, item_id),
    INDEX idx_rimap_item (item_id),
    CONSTRAINT fk_rimap_reagent
        FOREIGN KEY (reagent_id) REFERENCES reagent(reagent_id) ON DELETE CASCADE,
    CONSTRAINT fk_rimap_item
        FOREIGN KEY (item_id) REFERENCES items(item_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- -------------------------------------------------------------
-- 10. qc_records : 品管紀錄 (改為關聯式)
--    以 FK 連結組別 / 儀器 / 品管液；同時保留關鍵欄位「快照」，
--    因為 mean/SD 會隨平測改變，紀錄須留下當下實際採用的數值供稽核。
-- -------------------------------------------------------------
CREATE TABLE qc_records (
    id                        BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,

    -- 關聯 FK
    reagent_qc_id             CHAR(36)     NULL COMMENT 'FK → reagent_qc.reagent_qc_id (此筆品管使用的品管液)',
    group_id                  CHAR(36)     NULL COMMENT 'FK → lab_group.group_id',
    instrument_serial_number  VARCHAR(100) NOT NULL COMMENT 'FK → instruments.serial_number',

    -- 快照欄位 (紀錄當下的實際值，不隨主檔異動)
    instrument_name           VARCHAR(200) NOT NULL,
    test_item                 VARCHAR(100) NOT NULL,
    test_item_full_name       VARCHAR(200) NULL,
    qc_level                  VARCHAR(50)  NULL,
    qc_lot_number             VARCHAR(100) NULL,
    unit                      VARCHAR(50)  NULL,
    lot_mean                  DECIMAL(15,4) NULL COMMENT '本次採用的均值 (快照)',
    lot_standard_deviation    DECIMAL(15,6) NULL COMMENT '本次採用的 SD (快照)',
    acceptable_range_lower    DECIMAL(15,4) NULL,
    acceptable_range_upper    DECIMAL(15,4) NULL,

    -- 量測與判讀
    qc_date                   DATE         NOT NULL,
    qc_time                   TIME         NOT NULL,
    operator                  VARCHAR(100) NULL,
    qc_result_value           DECIMAL(15,4) NULL,
    z_score                   DECIMAL(10,2) NULL,
    qc_status                 VARCHAR(20)  NOT NULL DEFAULT 'Pass' COMMENT 'Pass / Warning / Fail',
    westgard_rule_violation   TEXT         NULL,
    remark                    TEXT         NULL,
    created_at                DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

    INDEX idx_qc_date (qc_date),
    INDEX idx_qc_instrument (instrument_serial_number),
    INDEX idx_qc_group (group_id),
    INDEX idx_qc_rqc (reagent_qc_id),
    INDEX idx_qc_item (test_item),
    INDEX idx_qc_sn_item_level (instrument_serial_number, test_item, qc_level),

    CONSTRAINT fk_qc_instrument
        FOREIGN KEY (instrument_serial_number) REFERENCES instruments(serial_number),
    CONSTRAINT fk_qc_group
        FOREIGN KEY (group_id) REFERENCES lab_group(group_id),
    CONSTRAINT fk_qc_rqc
        FOREIGN KEY (reagent_qc_id) REFERENCES reagent_qc(reagent_qc_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- =============================================================
-- 種子資料：組別主檔 (4 個固定組別)
-- =============================================================
INSERT INTO lab_group (group_name, group_code, description) VALUES
    ('生化免疫組', 'BIO', '臨床生化與免疫檢驗'),
    ('血液組',     'HEM', '血液學與凝固檢驗'),
    ('鏡檢組',     'URN', '尿液與鏡檢'),
    ('血庫組',     'BB',  '輸血醫學 / 血庫');


-- =============================================================
-- 種子資料：檢體類別主檔 (固定清單，可再由 API 增補)
-- =============================================================
INSERT INTO specimen_type (code, name, description) VALUES
    ('B',   'BLOOD', '全血 / 血清 / 血漿'),
    ('U',   'URINE', '尿液'),
    ('CSF', 'CSF',   '腦脊髓液'),
    ('BF',  'BODY FLUID', '體液 (胸水 / 腹水等)'),
    ('ST',  'STOOL', '糞便');
