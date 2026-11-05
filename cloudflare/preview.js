(() => {
  "use strict";

  const instruments = [
    { section_name: "示範生化組", serial_number: "DEMO-CHEM-01", instrument_name: "示範生化儀", instrument_role: "主機" },
    { section_name: "示範血液組", serial_number: "DEMO-HEMA-01", instrument_name: "示範血球儀", instrument_role: "主機" },
  ];
  const series = [
    { item_code: "GLU", unit: "mg/dL", mean: 100, sd: 2, scores: [-0.4, 0.6, -1.1, 0.2, 0.9, -0.5, 2.2, 3.2] },
    { item_code: "HGB", unit: "g/dL", mean: 12, sd: 0.2, scores: [0.5, -0.7, 0.2, 0.8, -0.9, -2.3, -2.5, 0.6] },
  ];
  const today = new Date().toISOString().slice(0, 10);
  const dayStart = Date.parse(today);
  const records = series.flatMap((sample, seriesIndex) => sample.scores.map((z, index) => {
    const day = new Date(dayStart - (sample.scores.length - index - 1) * 86400000)
      .toISOString().slice(0, 10);
    const prior = sample.scores[index - 1];
    const flags = [];
    if (Math.abs(z) > 3) flags.push("1-3s");
    else if (Math.abs(z) > 2) flags.push("1-2s");
    if (Math.abs(z) > 2 && Math.abs(prior) > 2 && Math.sign(z) === Math.sign(prior)) {
      flags.push("2-2s");
    }
    return {
      ...instruments[seriesIndex],
      item_code: sample.item_code,
      specimen_code: "B",
      qc_level: "L1",
      qc_lot_number: "DEMO-L1",
      run_at: `${day}T08:30:00`,
      result_value: Number((sample.mean + z * sample.sd).toFixed(2)),
      unit_snapshot: sample.unit,
      target_mean_snapshot: sample.mean,
      target_sd_snapshot: sample.sd,
      z_score: z,
      result_status: flags.some((flag) => flag !== "1-2s") ? "FAIL" : flags.length ? "WARNING" : "PASS",
      westgard_flags: flags,
    };
  }));

  function filterRecords(params) {
    return records.filter((row) => {
      const day = row.run_at.slice(0, 10);
      return (!params.get("date_from") || day >= params.get("date_from"))
        && (!params.get("date_to") || day <= params.get("date_to"))
        && (!params.get("section_name") || row.section_name === params.get("section_name"))
        && (!params.get("instrument_serial_number") || row.serial_number === params.get("instrument_serial_number"))
        && (!params.get("item_code") || row.item_code === params.get("item_code").toUpperCase())
        && (!params.get("result_status") || row.result_status === params.get("result_status"));
    });
  }

  function dashboard(day) {
    const rows = records.filter((row) => row.run_at.startsWith(day));
    const byInstrument = {}, ruleCounts = {};
    const counts = { PASS: 0, WARNING: 0, FAIL: 0 };
    for (const row of rows) {
      counts[row.result_status]++;
      const stats = byInstrument[row.instrument_name] ??= { total: 0, fail: 0 };
      stats.total++;
      if (row.result_status === "FAIL") stats.fail++;
      for (const flag of row.westgard_flags) ruleCounts[flag] = (ruleCounts[flag] || 0) + 1;
    }
    const violations = rows.filter((row) => row.westgard_flags.length);
    return {
      total_qc: rows.length, pass_count: counts.PASS, warning_count: counts.WARNING,
      fail_count: counts.FAIL, pass_rate: rows.length ? Math.round(100 * counts.PASS / rows.length) : 0,
      westgard_violation_count: violations.length, violations, by_instrument: byInstrument, rule_counts: ruleCounts,
    };
  }

  function trend(rows) {
    if (!rows.length) return [];
    const first = rows[0];
    return [{
      label: `${first.instrument_name} · ${first.item_code} · ${first.qc_lot_number}`,
      mean: first.target_mean_snapshot, sd: first.target_sd_snapshot, unit: first.unit_snapshot,
      points: rows.map((row) => ({
        run_at: row.run_at, value: row.result_value, z: row.z_score,
        status: row.result_status, westgard: row.westgard_flags,
      })),
    }];
  }

  window.pjqaqcPreviewFetch = async (path, options = {}) => {
    if ((options.method || "GET") !== "GET") {
      return Response.json({ detail: "預覽模式僅供瀏覽。" }, { status: 405 });
    }
    const { pathname, searchParams } = new URL(path, window.location.origin);
    switch (pathname) {
      case "/api/sections": return Response.json(instruments.map(({ section_name }) => ({ section_name })));
      case "/api/specimen-types": return Response.json([{ specimen_code: "B", specimen_name: "示範血液檢體" }]);
      case "/api/instruments": return Response.json({ all: instruments });
      case "/api/dashboard": return Response.json(dashboard(searchParams.get("target_date") || today));
      case "/api/assays": return Response.json(
        series.filter((_, index) => instruments[index].serial_number === searchParams.get("instrument_serial_number")),
      );
      case "/api/qc-results": return Response.json(filterRecords(searchParams).sort(
        (a, b) => b.run_at.localeCompare(a.run_at),
      ));
      case "/api/qc-results/lj": return Response.json(trend(filterRecords(searchParams)));
      default: return Response.json({ detail: "此功能在預覽模式中未提供。" }, { status: 404 });
    }
  };
})();
