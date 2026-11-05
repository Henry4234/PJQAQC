// DEMO 模式的資料來源：以固定種子產生合成資料，回應形狀與正式 API 相同。
// 此檔不發出任何網路請求，也不含任何正式資料；所有寫入一律回 403。
(() => {
  "use strict";

  const DAY_MS = 86400000;
  const HISTORY_DAYS = 30;
  const today = new Date().toISOString().slice(0, 10);
  const daysAgo = (n) => new Date(Date.parse(today) - n * DAY_MS).toISOString().slice(0, 10);

  /* ------------------------------------------------------------ 基礎主檔 */
  const sections = [
    { section_id: "sec-chem", section_code: "CHEM", section_name: "示範生化組", description: "合成示範資料", active: true },
    { section_id: "sec-hema", section_code: "HEMA", section_name: "示範血液組", description: "合成示範資料", active: true },
  ];

  const specimenTypes = [
    { specimen_type_id: "spec-b", specimen_code: "B", specimen_name: "BLOOD", description: "血液", active: true },
    { specimen_type_id: "spec-u", specimen_code: "U", specimen_name: "URINE", description: "尿液", active: true },
  ];

  const instrument = (serial, name, sectionId, role, model, extra = {}) => {
    const section = sections.find((s) => s.section_id === sectionId);
    return {
      instrument_id: `inst-${serial}`, serial_number: serial, instrument_name: name, section_id: sectionId,
      section_name: section.section_name, section_code: section.section_code, instrument_role: role,
      model_name: model, manufacturer: "示範儀器公司", installed_at: "2024-03-01", retired_at: null,
      backup_of_serial: null, backup_of_name: null, active: true, ...extra,
    };
  };
  const instruments = [
    instrument("DEMO-CHEM-01", "示範生化儀 A", "sec-chem", "主機", "DEMO-CX100"),
    instrument("DEMO-CHEM-02", "示範生化儀 B", "sec-chem", "備機", "DEMO-CX100",
      { backup_of_serial: "DEMO-CHEM-01", backup_of_name: "示範生化儀 A" }),
    instrument("DEMO-HEMA-01", "示範血球儀", "sec-hema", "主機", "DEMO-HX50"),
    instrument("DEMO-CHEM-00", "示範舊生化儀", "sec-chem", "其他", "DEMO-CX50",
      { active: false, retired_at: "2025-12-31" }),
  ];

  const ITEMS = {
    GLU: { name: "Glucose", unit: "mg/dL", loinc: "2345-7", method: "Hexokinase", decimals: 0, reagent: "rg-glu" },
    CRE: { name: "Creatinine", unit: "mg/dL", loinc: "2160-0", method: "Enzymatic", decimals: 2, reagent: "rg-cre" },
    ALT: { name: "Alanine aminotransferase", unit: "U/L", loinc: "1742-6", method: "IFCC", decimals: 0, reagent: "rg-alt" },
    NA: { name: "Sodium", unit: "mmol/L", loinc: "2951-2", method: "ISE", decimals: 1, reagent: "rg-ise" },
    WBC: { name: "White blood cell count", unit: "10^3/uL", loinc: "6690-2", method: "Flow cytometry", decimals: 2, reagent: "rg-hema" },
    HGB: { name: "Hemoglobin", unit: "g/dL", loinc: "718-7", method: "SLS", decimals: 1, reagent: "rg-hema" },
    PLT: { name: "Platelet count", unit: "10^3/uL", loinc: "777-3", method: "Impedance", decimals: 0, reagent: "rg-hema" },
  };
  const testItems = Object.entries(ITEMS).map(([code, item]) => ({
    test_item_id: `item-${code}`, item_code: code, item_name: item.name,
    default_unit: item.unit, loinc_code: item.loinc, active: true,
  }));

  /* ------------------------------------------------------------ 檢驗設定 */
  const ASSAY_DEFS = [
    ["DEMO-CHEM-01", "GLU", "B"], ["DEMO-CHEM-01", "CRE", "B"], ["DEMO-CHEM-01", "ALT", "B"],
    ["DEMO-CHEM-01", "NA", "B"], ["DEMO-CHEM-01", "CRE", "U"],
    ["DEMO-CHEM-02", "GLU", "B"], ["DEMO-CHEM-02", "CRE", "B"],
    ["DEMO-HEMA-01", "WBC", "B"], ["DEMO-HEMA-01", "HGB", "B"], ["DEMO-HEMA-01", "PLT", "B"],
  ];
  const assays = ASSAY_DEFS.map(([serial, code, specimen]) => {
    const inst = instruments.find((i) => i.serial_number === serial);
    const item = ITEMS[code];
    return {
      assay_id: `assay-${serial}-${code}-${specimen}`, instrument_id: inst.instrument_id,
      test_item_id: `item-${code}`, serial_number: serial, instrument_name: inst.instrument_name,
      section_name: inst.section_name, instrument_role: inst.instrument_role, item_code: code,
      item_name: item.name, specimen_code: specimen, result_unit: item.unit, decimal_places: item.decimals,
      method_name: item.method, instrument_test_code: `${code}${specimen === "U" ? "-U" : ""}`,
      valid_from: "2024-03-01", valid_to: null, active: true,
    };
  });
  const isHema = (assay) => assay.section_name === "示範血液組";

  /* ------------------------------------------------------------ 產品與批號 */
  const expiry = (months) => new Date(Date.parse(today) + months * 30 * DAY_MS).toISOString().slice(0, 10);

  const reagentLot = (productId, lot, status, months, tested = true) => ({
    reagent_lot_id: `rl-${lot}`, reagent_product_id: productId, lot_number: lot, received_at: daysAgo(40),
    expiry_date: expiry(months), lot_status: status, parallel_test_done: tested,
    parallel_test_date: tested ? daysAgo(35) : null, same_lot_as_previous: false, note: null,
  });
  const product = (idField, id, code, name, extra, lots) => ({
    [idField]: id, product_code: code, product_name: name, manufacturer: "示範試劑公司",
    catalog_number: `CAT-${code}`, storage_condition: "2–8°C 冷藏", active: true, lots, ...extra,
  });
  const reagent = (id, code, name, lots, extra = {}) =>
    product("reagent_product_id", id, code, name, extra, lots);

  const reagentProducts = [
    reagent("rg-glu", "R-GLU", "示範葡萄糖試劑", [
      reagentLot("rg-glu", "DEMO-R-GLU-01", "IN_USE", 6),
      reagentLot("rg-glu", "DEMO-R-GLU-02", "AVAILABLE", 12, false),
    ]),
    reagent("rg-cre", "R-CRE", "示範肌酸酐試劑", [reagentLot("rg-cre", "DEMO-R-CRE-01", "IN_USE", 5)]),
    reagent("rg-alt", "R-ALT", "示範 ALT 試劑", [reagentLot("rg-alt", "DEMO-R-ALT-01", "IN_USE", 4)]),
    reagent("rg-ise", "R-ISE", "示範電解質試劑", [reagentLot("rg-ise", "DEMO-R-ISE-01", "IN_USE", 8)]),
    reagent("rg-hema", "R-HEMA", "示範血球稀釋液", [reagentLot("rg-hema", "DEMO-R-HEMA-01", "IN_USE", 7)]),
    reagent("rg-old", "R-OLD", "示範舊型試劑（已停用）", [], { active: false }),
  ];

  const qcLot = (id, productId, lot, level, status, tested) => ({
    qc_lot_id: id, qc_product_id: productId, lot_number: lot, level_code: level, received_at: daysAgo(60),
    expiry_date: expiry(9), lot_status: status, parallel_test_done: tested,
    parallel_test_date: tested ? daysAgo(HISTORY_DAYS) : null, note: null,
  });
  const qcProducts = [
    product("qc_product_id", "qc-chem", "QC-CHEM", "示範生化品管液", { matrix_description: "人工基質" }, [
      qcLot("ql-c1", "qc-chem", "DEMO-QC-C101", "Level 1", "IN_USE", true),
      qcLot("ql-c2", "qc-chem", "DEMO-QC-C102", "Level 2", "IN_USE", true),
      qcLot("ql-c3", "qc-chem", "DEMO-QC-C201", "Level 1", "AVAILABLE", false),
    ]),
    product("qc_product_id", "qc-hema", "QC-HEMA", "示範血球品管液", { matrix_description: "穩定化血球" }, [
      qcLot("ql-h1", "qc-hema", "DEMO-QC-H101", "Level 1", "IN_USE", true),
      qcLot("ql-h2", "qc-hema", "DEMO-QC-H102", "Level 2", "IN_USE", true),
    ]),
  ];
  const allQcLots = qcProducts.flatMap((p) => p.lots.map((lot) => ({ ...lot, product_name: p.product_name })));
  const findQcLot = (id) => allQcLots.find((lot) => lot.qc_lot_id === id);

  const calibratorLot = (id, productId, lot) => ({
    calibrator_lot_id: id, calibrator_product_id: productId, lot_number: lot, level_code: "DEFAULT",
    received_at: daysAgo(50), expiry_date: expiry(10), lot_status: "IN_USE",
    assigned_value_text: "依原廠說明書", note: null,
  });
  const calibratorProducts = [
    product("calibrator_product_id", "cal-chem", "CAL-CHEM", "示範生化校正液", { matrix_description: "人工基質" },
      [calibratorLot("cl-chem", "cal-chem", "DEMO-CAL-C01")]),
    product("calibrator_product_id", "cal-hema", "CAL-HEMA", "示範血球校正液", { matrix_description: "穩定化血球" },
      [calibratorLot("cl-hema", "cal-hema", "DEMO-CAL-H01")]),
  ];

  const reagentProductFor = (assay) =>
    reagentProducts.find((p) => p.reagent_product_id === ITEMS[assay.item_code].reagent);
  const qcProductFor = (assay) => (isHema(assay) ? qcProducts[1] : qcProducts[0]);
  const calibratorFor = (assay) => (isHema(assay) ? calibratorProducts[1] : calibratorProducts[0]);

  /* ------------------------------------------------------------ 目標值 */
  // [Level 1 mean, sd, Level 2 mean, sd]
  const TARGETS = {
    "GLU/B": [95, 2.2, 250, 5], "CRE/B": [1, 0.03, 4.5, 0.1], "ALT/B": [35, 1.5, 120, 3.5],
    "NA/B": [140, 1, 120, 1.2], "CRE/U": [60, 2, 150, 4], "WBC/B": [5, 0.15, 15, 0.4],
    "HGB/B": [12, 0.2, 16.5, 0.25], "PLT/B": [230, 7, 480, 12],
  };
  const target = (assay, lotId, mean, sd, source, effectiveFrom, effectiveTo = null) => ({
    qc_target_id: `tg-${assay.assay_id}-${lotId}-${source}`, assay_id: assay.assay_id, qc_lot_id: lotId,
    qc_product_id: findQcLot(lotId).qc_product_id, target_mean: mean, target_sd: sd, target_source: source,
    acceptable_low: Number((mean - 3 * sd).toFixed(3)), acceptable_high: Number((mean + 3 * sd).toFixed(3)),
    effective_from: `${effectiveFrom}T00:00:00`, effective_to: effectiveTo && `${effectiveTo}T00:00:00`,
    approved_by: source === "LAB" ? "示範主管" : null, note: null,
  });
  const qcTargets = assays.flatMap((assay) => {
    const [mean1, sd1, mean2, sd2] = TARGETS[`${assay.item_code}/${assay.specimen_code}`];
    const [lot1, lot2] = isHema(assay) ? ["ql-h1", "ql-h2"] : ["ql-c1", "ql-c2"];
    const rows = [
      target(assay, lot1, mean1, sd1, "LAB", daysAgo(HISTORY_DAYS)),
      target(assay, lot2, mean2, sd2, "LAB", daysAgo(HISTORY_DAYS)),
      // 舊版本：平測前的原廠值，已收效但保留
      target(assay, lot1, mean1, sd1 * 1.5, "MANUFACTURER", daysAgo(HISTORY_DAYS + 30), daysAgo(HISTORY_DAYS)),
    ];
    // 新批號尚未平測，會出現在「待平測」清單
    if (!isHema(assay) && assay.serial_number === "DEMO-CHEM-01" && assay.specimen_code === "B") {
      rows.push(target(assay, "ql-c3", mean1 * 1.02, sd1 * 1.4, "MANUFACTURER", daysAgo(3)));
    }
    return rows;
  });

  const targetRow = (t) => {
    const assay = assays.find((a) => a.assay_id === t.assay_id);
    const lot = findQcLot(t.qc_lot_id);
    return {
      ...t, serial_number: assay.serial_number, instrument_name: assay.instrument_name,
      item_code: assay.item_code, item_name: assay.item_name, specimen_code: assay.specimen_code,
      result_unit: assay.result_unit, lot_number: lot.lot_number, level_code: lot.level_code,
      expiry_date: lot.expiry_date, lot_status: lot.lot_status, parallel_test_done: lot.parallel_test_done,
      qc_product_name: lot.product_name,
    };
  };

  /* ------------------------------------------------------------ 品管結果 */
  // 與 backend/westgard.py 相同的規則
  const REJECTION_RULES = new Set(["1-3s", "2-2s", "R-4s", "4-1s", "10x"]);

  function westgardFlags(series) {
    const n = series.length;
    const z = series[n - 1];
    const flags = new Set();
    if (Math.abs(z) > 3) flags.add("1-3s");
    else if (Math.abs(z) > 2) flags.add("1-2s");
    if (n >= 2) {
      const prev = series[n - 2];
      if (Math.abs(prev) > 2 && Math.abs(z) > 2 && (prev > 0) === (z > 0)) flags.add("2-2s");
      if (Math.abs(z - prev) > 4) flags.add("R-4s");
    }
    const sameSide = (values, limit) =>
      values.every((v) => v > limit) || values.every((v) => v < -limit);
    if (n >= 4 && sameSide(series.slice(-4), 1)) flags.add("4-1s");
    if (n >= 10 && sameSide(series.slice(-10), 0)) flags.add("10x");
    return [...flags].sort();
  }

  const statusFromFlags = (flags) =>
    flags.some((f) => REJECTION_RULES.has(f)) ? "FAIL" : flags.length ? "WARNING" : "PASS";

  function seededRandom(seed) {
    let state = seed >>> 0;
    return () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const hashText = (text) => [...text].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619), 2166136261);

  // 刻意安排的違規，讓儀表板與 L-J 圖有內容可看；key 為「幾天前」
  const SCRIPTED = {
    "tg-assay-DEMO-CHEM-01-GLU-B-ql-c1-LAB": { 0: 3.3 },
    "tg-assay-DEMO-HEMA-01-HGB-B-ql-h2-LAB": { 1: 2.3, 0: 2.6 },
    "tg-assay-DEMO-CHEM-01-ALT-B-ql-c1-LAB": { 11: 1.2, 10: 1.4, 9: 1.1, 8: 1.5 },
    "tg-assay-DEMO-CHEM-01-NA-B-ql-c2-LAB": { 0: -2.4 },
  };
  const NOTES = {
    "1-3s": "示範：品管液開封過久，更換後重測通過",
    "2-2s": "示範：試劑即將用盡，更換試劑後重新校正",
    "4-1s": "示範：系統性偏移，安排校正",
  };

  const qcResults = qcTargets
    .filter((t) => !t.effective_to && t.target_source === "LAB")
    .flatMap((t) => {
      const assay = assays.find((a) => a.assay_id === t.assay_id);
      const lot = findQcLot(t.qc_lot_id);
      const random = seededRandom(hashText(t.qc_target_id));
      const scripted = SCRIPTED[t.qc_target_id] || {};
      const series = [];
      const rows = [];
      for (let ago = HISTORY_DAYS - 1; ago >= 0; ago--) {
        const natural = (random() + random() + random() + random() - 2) * 1.2;
        const value = Number((t.target_mean + (scripted[ago] ?? natural) * t.target_sd)
          .toFixed(assay.decimal_places + 1));
        const z = Number(((value - t.target_mean) / t.target_sd).toFixed(4));
        series.push(z);
        const flags = westgardFlags(series);
        const rule = flags.find((f) => NOTES[f]);
        const minute = String(10 + Math.floor(random() * 40)).padStart(2, "0");
        rows.push({
          qc_result_id: `res-${t.qc_target_id}-${ago}`, qc_run_id: `run-${t.qc_lot_id}-${ago}`,
          assay_id: assay.assay_id, qc_lot_id: lot.qc_lot_id, section_name: assay.section_name,
          serial_number: assay.serial_number, instrument_name: assay.instrument_name,
          item_code: assay.item_code, item_name: assay.item_name, specimen_code: assay.specimen_code,
          qc_product_name: lot.product_name, qc_level: lot.level_code, qc_lot_number: lot.lot_number,
          run_at: `${daysAgo(ago)}T08:${minute}:00`, operator_id: "DEMO01", result_value: value,
          unit_snapshot: assay.result_unit, target_mean_snapshot: t.target_mean, target_sd_snapshot: t.target_sd,
          z_score: z, result_status: statusFromFlags(flags), westgard_flags: flags,
          note: scripted[ago] !== undefined && rule ? NOTES[rule] : null,
        });
      }
      return rows;
    });

  function filterResults(params) {
    const get = (name) => params.get(name);
    return qcResults.filter((r) => {
      const day = r.run_at.slice(0, 10);
      return (!get("date_from") || day >= get("date_from"))
        && (!get("date_to") || day <= get("date_to"))
        && (!get("section_name") || r.section_name === get("section_name"))
        && (!get("instrument_serial_number") || r.serial_number === get("instrument_serial_number"))
        && (!get("item_code") || r.item_code === get("item_code").toUpperCase())
        && (!get("specimen_code") || r.specimen_code === get("specimen_code"))
        && (!get("result_status") || r.result_status === get("result_status"));
    });
  }

  function listResults(params) {
    const rows = filterResults(params).sort((a, b) => b.run_at.localeCompare(a.run_at));
    return rows.slice(0, Number(params.get("limit")) || 500);
  }

  function ljSeries(params) {
    const series = new Map();
    filterResults(params)
      .sort((a, b) => a.run_at.localeCompare(b.run_at))
      .forEach((r) => {
        const label = `${r.qc_product_name} · ${r.qc_level} · ${r.qc_lot_number}`;
        if (!series.has(label)) {
          series.set(label, {
            label, qc_product_name: r.qc_product_name, qc_level: r.qc_level, qc_lot_number: r.qc_lot_number,
            unit: r.unit_snapshot, mean: r.target_mean_snapshot, sd: r.target_sd_snapshot, points: [],
          });
        }
        series.get(label).points.push({
          run_at: r.run_at, value: r.result_value, z: r.z_score,
          status: r.result_status, westgard: r.westgard_flags,
        });
      });
    return [...series.values()];
  }

  function dashboard(params) {
    const day = params.get("target_date") || today;
    const rows = qcResults.filter((r) => r.run_at.startsWith(day));
    const count = (status) => rows.filter((r) => r.result_status === status).length;
    const violations = rows.filter((r) => r.westgard_flags.length);
    const byInstrument = {};
    const ruleCounts = {};
    rows.forEach((r) => {
      const stats = (byInstrument[r.instrument_name] ??= { total: 0, fail: 0 });
      stats.total += 1;
      if (r.result_status === "FAIL") stats.fail += 1;
      r.westgard_flags.forEach((flag) => { ruleCounts[flag] = (ruleCounts[flag] || 0) + 1; });
    });
    return {
      date: day, total_qc: rows.length, pass_count: count("PASS"), warning_count: count("WARNING"),
      fail_count: count("FAIL"), westgard_violation_count: violations.length,
      pass_rate: rows.length ? Math.round((count("PASS") / rows.length) * 1000) / 10 : 0,
      by_instrument: byInstrument, rule_counts: ruleCounts, violations,
    };
  }

  /* ------------------------------------------------------------ 上機與校正 */
  const reagentLoads = [
    ["DEMO-CHEM-01", "R1", "rg-glu", 12, null], ["DEMO-CHEM-01", "R2", "rg-cre", 10, null],
    ["DEMO-CHEM-01", "R3", "rg-alt", 8, null], ["DEMO-CHEM-02", "R1", "rg-glu", 20, null],
    ["DEMO-HEMA-01", "D1", "rg-hema", 5, null], ["DEMO-HEMA-01", "D1", "rg-hema", 25, 5],
  ].map(([serial, position, productId, loadedAgo, unloadedAgo], index) => {
    const inst = instruments.find((i) => i.serial_number === serial);
    const prod = reagentProducts.find((p) => p.reagent_product_id === productId);
    const lot = prod.lots[0];
    return {
      reagent_load_id: `load-${index}`, instrument_id: inst.instrument_id, reagent_lot_id: lot.reagent_lot_id,
      position_code: position, loaded_at: `${daysAgo(loadedAgo)}T09:00:00`, loaded_by: "DEMO01",
      unloaded_at: unloadedAgo === null ? null : `${daysAgo(unloadedAgo)}T17:30:00`,
      unloaded_by: unloadedAgo === null ? null : "DEMO02", note: null, serial_number: serial,
      instrument_name: inst.instrument_name, lot_number: lot.lot_number, expiry_date: lot.expiry_date,
      lot_status: lot.lot_status, product_name: prod.product_name,
    };
  });

  const calibrationEvents = [
    ["DEMO-CHEM-01", 20, "SCHEDULED", "PASS", "ALT", null],
    ["DEMO-CHEM-01", 7, "QC_FAILURE", "PASS", "ALT", "示範：4-1s 系統性偏移後校正"],
    ["DEMO-HEMA-01", 14, "NEW_LOT", "PASS", "HGB", null],
  ].map(([serial, ago, reason, status, code, note], index) => {
    const inst = instruments.find((i) => i.serial_number === serial);
    const assay = assays.find((a) => a.serial_number === serial && a.item_code === code);
    const calibrator = calibratorFor(assay);
    return {
      calibration_event_id: `cal-${index}`, instrument_id: inst.instrument_id,
      calibrator_lot_id: calibrator.lots[0].calibrator_lot_id, performed_at: `${daysAgo(ago)}T07:45:00`,
      operator_id: "DEMO01", calibration_reason: reason, event_status: status, note,
      serial_number: serial, instrument_name: inst.instrument_name,
      calibrator_product_name: calibrator.product_name, calibrator_lot_number: calibrator.lots[0].lot_number,
      assays: [{ assay_status: status, pre_bias: null, post_bias: null, item_code: code, specimen_code: assay.specimen_code }],
    };
  });

  /* ------------------------------------------------------------ 組合查詢 */
  const withoutLots = ({ lots, ...rest }) => rest;
  const usableLots = (product_) =>
    product_.lots.filter((lot) => lot.lot_status === "IN_USE" || lot.lot_status === "AVAILABLE");
  const unique = (values) => [...new Set(values)];

  function assayDetail(assayId) {
    const assay = assays.find((a) => a.assay_id === assayId);
    if (!assay) return null;
    return {
      ...assay,
      reagents: [{ ...withoutLots(reagentProductFor(assay)), reagent_role: "PRIMARY", required: true, priority: 1 }],
      qc_products: [{ ...withoutLots(qcProductFor(assay)), required: true, priority: 1 }],
      calibrators: [{ ...withoutLots(calibratorFor(assay)), required: true, priority: 1 }],
      qc_targets: qcTargets.filter((t) => t.assay_id === assayId && !t.effective_to).map(targetRow),
    };
  }

  function erGraph(serial) {
    const inst = instruments.find((i) => i.serial_number === serial);
    if (!inst) return null;
    const own = assays.filter((a) => a.serial_number === serial);
    const reagents = unique(own.map(reagentProductFor));
    const qcs = unique(own.map(qcProductFor));
    const reagentAssay = own.map((a) => ({
      reagent_product_id: reagentProductFor(a).reagent_product_id, assay_id: a.assay_id, reagent_role: "PRIMARY",
    }));
    const qcAssay = own.map((a) => ({ qc_product_id: qcProductFor(a).qc_product_id, assay_id: a.assay_id }));
    const qcReagent = qcs.flatMap((q) => reagents.map((r) => ({
      qc_product_id: q.qc_product_id, reagent_product_id: r.reagent_product_id,
    })));
    return {
      instrument: inst,
      assays: own.map(({ assay_id, item_code, item_name, specimen_code, result_unit }) =>
        ({ assay_id, item_code, item_name, specimen_code, result_unit })),
      reagents: reagents.map((r) => ({
        reagent_product_id: r.reagent_product_id, product_name: r.product_name,
        manufacturer: r.manufacturer, lots: usableLots(r),
      })),
      qc_products: qcs.map((q) => ({
        qc_product_id: q.qc_product_id, product_name: q.product_name,
        manufacturer: q.manufacturer, lots: usableLots(q),
      })),
      edges: { qc_reagent: qcReagent, reagent_assay: reagentAssay, qc_assay: qcAssay },
      counts: {
        assays: own.length, reagents: reagents.length, qc_products: qcs.length,
        reagent_assay_links: reagentAssay.length, qc_assay_links: qcAssay.length,
      },
    };
  }

  const activeOnly = (rows, params) =>
    (params.get("include_inactive") === "true" ? rows : rows.filter((r) => r.active));

  /* ------------------------------------------------------------ 路由 */
  const ROUTES = [
    [/^\/api\/sections$/, () => sections],
    [/^\/api\/specimen-types$/, () => specimenTypes],
    [/^\/api\/instruments$/, (_, q) => {
      const all = activeOnly(instruments, q);
      const groups = {};
      all.forEach((i) => { (groups[i.section_name] ??= []).push(i); });
      return { groups, all };
    }],
    [/^\/api\/test-items$/, (_, q) => {
      const keyword = (q.get("q") || "").toLowerCase();
      return testItems.filter((i) => !keyword
        || i.item_code.toLowerCase().includes(keyword) || i.item_name.toLowerCase().includes(keyword));
    }],
    [/^\/api\/assays$/, (_, q) => activeOnly(assays, q).filter((a) =>
      (!q.get("instrument_serial_number") || a.serial_number === q.get("instrument_serial_number"))
      && (!q.get("section_name") || a.section_name === q.get("section_name"))
      && (!q.get("item_code") || a.item_code === q.get("item_code"))
      && (!q.get("specimen_code") || a.specimen_code === q.get("specimen_code")))],
    [/^\/api\/assays\/([^/]+)$/, (m) => assayDetail(decodeURIComponent(m[1]))],
    [/^\/api\/reagent-products$/, (_, q) => activeOnly(reagentProducts, q)],
    [/^\/api\/qc-products$/, (_, q) => activeOnly(qcProducts, q)],
    [/^\/api\/calibrator-products$/, (_, q) => activeOnly(calibratorProducts, q)],
    [/^\/api\/qc-lots$/, (_, q) => {
      const serial = q.get("instrument_serial_number");
      const productIds = serial
        ? assays.filter((a) => a.serial_number === serial).map((a) => qcProductFor(a).qc_product_id)
        : null;
      return allQcLots.filter((lot) =>
        (!productIds || productIds.includes(lot.qc_product_id))
        && (!q.get("qc_product_id") || lot.qc_product_id === q.get("qc_product_id")));
    }],
    [/^\/api\/qc-targets$/, (_, q) => qcTargets
      .filter((t) => q.get("include_history") === "true" || !t.effective_to)
      .map(targetRow)
      .filter((t) => (!q.get("instrument_serial_number") || t.serial_number === q.get("instrument_serial_number"))
        && (!q.get("assay_id") || t.assay_id === q.get("assay_id"))
        && (!q.get("qc_lot_id") || t.qc_lot_id === q.get("qc_lot_id")))],
    [/^\/api\/qc-targets\/pending-parallel-test$/, (_, q) => qcTargets
      .filter((t) => !t.effective_to && t.target_source === "MANUFACTURER")
      .map(targetRow)
      .filter((t) => !q.get("instrument_serial_number") || t.serial_number === q.get("instrument_serial_number"))],
    [/^\/api\/qc-results$/, (_, q) => listResults(q)],
    [/^\/api\/qc-results\/lj$/, (_, q) => ljSeries(q)],
    [/^\/api\/dashboard$/, (_, q) => dashboard(q)],
    [/^\/api\/er-graph$/, (_, q) => erGraph(q.get("instrument_serial_number"))],
    [/^\/api\/reagent-loads$/, (_, q) => reagentLoads.filter((l) =>
      (!q.get("instrument_serial_number") || l.serial_number === q.get("instrument_serial_number"))
      && (q.get("current_only") === "false" || !l.unloaded_at))],
    [/^\/api\/calibration-events$/, (_, q) => calibrationEvents
      .filter((e) => {
        const day = e.performed_at.slice(0, 10);
        return (!q.get("instrument_serial_number") || e.serial_number === q.get("instrument_serial_number"))
          && (!q.get("date_from") || day >= q.get("date_from"))
          && (!q.get("date_to") || day <= q.get("date_to"));
      })
      .sort((a, b) => b.performed_at.localeCompare(a.performed_at))],
  ];

  const respond = (body, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json" },
  });

  globalThis.pjqaqcDemoFetch = async (path, options = {}) => {
    if ((options.method || "GET").toUpperCase() !== "GET") {
      return respond({ detail: "DEMO 模式僅供瀏覽，請登入編輯者帳號後再編輯。" }, 403);
    }
    const url = new URL(path, "https://demo.invalid");
    for (const [pattern, handler] of ROUTES) {
      const match = url.pathname.match(pattern);
      if (!match) continue;
      const body = handler(match, url.searchParams);
      return body === null ? respond({ detail: "DEMO 資料中查無此項目" }, 404) : respond(body);
    }
    return respond({ detail: "DEMO 模式未提供此功能" }, 404);
  };
})();
