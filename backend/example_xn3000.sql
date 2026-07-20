-- =============================================================
-- 範例資料：Sysmex XN-3000（血液組）示範新關聯式結構
-- 用法: mysql -h 192.168.0.111 -u PJQAQC -p PJQAQC < example_xn3000.sql
--
-- 示範關係：
--   儀器 1─N 試劑、儀器 1─N 項目
--   品管 N─M 試劑 (qc_reagent_map)、試劑 N─M 項目 (reagent_item_map)
-- 全部以自然鍵 (serial_number / 名稱 / 代碼) JOIN 帶出 UUID，方便閱讀與重跑。
-- =============================================================

-- 1) 儀器（歸屬血液組）
INSERT INTO instruments (serial_number, instrument_name, group_id, machine_role)
SELECT '43056', 'Sysmex XN-3000', g.group_id, '主機'
FROM lab_group g WHERE g.group_name = '血液組';

-- 2) 檢驗項目（17 項，1─N）
INSERT INTO items (instrument_serial_number, group_id, item_code, item_name, sort_order)
SELECT '43056', g.group_id, x.code, x.name, x.ord
FROM lab_group g
JOIN (
    SELECT 'RBC'     AS code, 'Red Blood Cell Count'            AS name,  1 AS ord UNION ALL
    SELECT 'HGB',      'Hemoglobin',                                       2 UNION ALL
    SELECT 'HCT',      'Hematocrit',                                       3 UNION ALL
    SELECT 'MCV',      'Mean Corpuscular Volume',                          4 UNION ALL
    SELECT 'MCH',      'Mean Corpuscular Hemoglobin',                      5 UNION ALL
    SELECT 'MCHC',     'Mean Corpuscular Hemoglobin Concentration',        6 UNION ALL
    SELECT 'RDW-SD',   'Red Cell Distribution Width - SD',                 7 UNION ALL
    SELECT 'RDW-CV',   'Red Cell Distribution Width - CV',                 8 UNION ALL
    SELECT 'PLT',      'Platelet Count',                                   9 UNION ALL
    SELECT 'WBC',      'White Blood Cell Count',                          10 UNION ALL
    SELECT 'BASO%',    'Basophils %',                                     11 UNION ALL
    SELECT 'NEUT%',    'Neutrophils %',                                   12 UNION ALL
    SELECT 'LYMPH%',   'Lymphocytes %',                                   13 UNION ALL
    SELECT 'MONO%',    'Monocytes %',                                     14 UNION ALL
    SELECT 'EO%',      'Eosinophils %',                                   15 UNION ALL
    SELECT 'NRBC%',    'Nucleated Red Blood Cell %',                      16 UNION ALL
    SELECT 'RET%',     'Reticulocyte %',                                  17
) x ON g.group_name = '血液組';

-- 3) 試劑（4 種，1─N；此處列出題目提供的 WNR/WDF 通道試劑）
INSERT INTO reagent (group_id, instrument_serial_number, test_item, reagent_name, lot_number, in_stock)
SELECT g.group_id, '43056', 'CBC', r.name, r.lot, TRUE
FROM lab_group g
JOIN (
    SELECT 'Fluorocell WNR' AS name, 'FWNR-2026A' AS lot UNION ALL
    SELECT 'Lysercell WNR',          'LWNR-2026A' UNION ALL
    SELECT 'Fluorocell WDF',         'FWDF-2026A' UNION ALL
    SELECT 'Lysercell WDF',          'LWDF-2026A'
) r ON g.group_name = '血液組';

-- 4) 品管液（3 個 level，1─N）
INSERT INTO reagent_qc (group_id, instrument_serial_number, test_item, qc_level, qc_lot_number, in_use)
SELECT g.group_id, '43056', 'CBC', q.lvl, q.lot, TRUE
FROM lab_group g
JOIN (
    SELECT 'Level 1' AS lvl, 'QC-XN-L1-2026' AS lot UNION ALL
    SELECT 'Level 2',        'QC-XN-L2-2026' UNION ALL
    SELECT 'Level 3',        'QC-XN-L3-2026'
) q ON g.group_name = '血液組';

-- 5) 品管 ↔ 試劑（多對多）：3 個 level 各涵蓋 4 種試劑 = 12 列
INSERT INTO qc_reagent_map (reagent_qc_id, reagent_id)
SELECT qc.reagent_qc_id, r.reagent_id
FROM reagent_qc qc
JOIN reagent r ON r.instrument_serial_number = qc.instrument_serial_number
WHERE qc.instrument_serial_number = '43056';

-- 6) 試劑 ↔ 項目（多對多）：Sysmex XN 通道對應（標準假設，請依實際校驗表確認）
--    WNR 通道 → WBC / BASO% / NRBC%
INSERT INTO reagent_item_map (reagent_id, item_id)
SELECT r.reagent_id, i.item_id
FROM reagent r
JOIN items i ON i.instrument_serial_number = r.instrument_serial_number
WHERE r.instrument_serial_number = '43056'
  AND r.reagent_name IN ('Fluorocell WNR', 'Lysercell WNR')
  AND i.item_code IN ('WBC', 'BASO%', 'NRBC%');

--    WDF 通道 → NEUT% / LYMPH% / MONO% / EO%
INSERT INTO reagent_item_map (reagent_id, item_id)
SELECT r.reagent_id, i.item_id
FROM reagent r
JOIN items i ON i.instrument_serial_number = r.instrument_serial_number
WHERE r.instrument_serial_number = '43056'
  AND r.reagent_name IN ('Fluorocell WDF', 'Lysercell WDF')
  AND i.item_code IN ('NEUT%', 'LYMPH%', 'MONO%', 'EO%');

-- 註：RBC / HGB / HCT / MCV / MCH / MCHC / RDW-SD / RDW-CV / PLT / RET% 由 RBC/PLT 阻抗通道、
--     SLS-HGB、RET 通道等其他試劑產生；題目未提供這些試劑，故先不建立對應，待補。
