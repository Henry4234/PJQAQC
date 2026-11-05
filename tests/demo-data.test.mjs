import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import "../frontend/demo-data.js";

const demo = (path, options) => globalThis.pjqaqcDemoFetch(path, options);
const read = async (path) => {
  const response = await demo(path);
  assert.equal(response.status, 200, `${path} should succeed in DEMO`);
  return response.json();
};
const today = new Date().toISOString().slice(0, 10);
const appSource = readFileSync(new URL("../frontend/app.js", import.meta.url), "utf8");

test("the demo never makes a network request", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("DEMO must not use the network"); };
  try {
    await read("/api/dashboard");
    await read("/api/instruments");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("every kind of write is refused", async () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const response = await demo("/api/instruments/1", { method, body: "{}" });
    assert.equal(response.status, 403, method);
    assert.match((await response.json()).detail, /DEMO/);
  }
});

test("every read endpoint the page calls has demo data", async () => {
  const called = new Set(
    [...appSource.matchAll(/["'`](\/api\/[a-z][a-z/-]*)/g)].map((m) => m[1].replace(/\/$/, "")),
  );
  // Endpoints that exist only behind edit buttons, plus the login API, are not read in DEMO.
  // The AI page itself requires an editor account, so its endpoints are not read there either.
  const writeOnly = new Set([
    "/api/auth/session", "/api/auth/login", "/api/auth/logout",
    "/api/ai-interpret", "/api/ai-providers", "/api/qc-runs",
    "/api/qc-targets/parallel-test", "/api/instruments/copy-to-backup", "/api/assays/batch",
    "/api/reagent-lots", "/api/calibrator-lots",
  ]);
  assert.ok(called.size > 12, `expected to find the page's endpoints, got ${[...called]}`);
  for (const path of called) {
    if (!writeOnly.has(path)) await read(`${path}?instrument_serial_number=DEMO-CHEM-01`);
  }
});

test("the dashboard has something to show today", async () => {
  const dashboard = await read(`/api/dashboard?target_date=${today}`);
  assert.equal(dashboard.total_qc, 20);
  assert.equal(dashboard.total_qc, dashboard.pass_count + dashboard.warning_count + dashboard.fail_count);
  assert.ok(dashboard.fail_count >= 2, "the scripted 1-3s and 2-2s failures should appear");
  assert.ok(dashboard.warning_count >= 1, "the scripted 1-2s warning should appear");
  assert.ok(dashboard.rule_counts["1-3s"] >= 1);
  assert.ok(dashboard.rule_counts["2-2s"] >= 1);
  assert.ok(dashboard.violations.every((v) => v.westgard_flags.length && v.instrument_name));
});

test("results follow the same Westgard rules as the backend", async () => {
  const rows = await read("/api/qc-results?limit=5000");
  assert.equal(rows.length, 20 * 30);
  const rejection = ["1-3s", "2-2s", "R-4s", "4-1s", "10x"];
  for (const row of rows) {
    const expected = row.westgard_flags.some((f) => rejection.includes(f)) ? "FAIL"
      : row.westgard_flags.includes("1-2s") ? "WARNING" : "PASS";
    assert.equal(row.result_status, expected, JSON.stringify(row));
    assert.equal(Math.abs(row.z_score) > 3, row.westgard_flags.includes("1-3s"));
    assert.ok(Math.abs(row.result_value - (row.target_mean_snapshot + row.z_score * row.target_sd_snapshot)) < 0.01);
  }
});

test("filters behave like the real API", async () => {
  const rows = await read(`/api/qc-results?instrument_serial_number=DEMO-HEMA-01&item_code=hgb&result_status=FAIL`);
  assert.ok(rows.length >= 1);
  assert.ok(rows.every((r) => r.serial_number === "DEMO-HEMA-01" && r.item_code === "HGB" && r.result_status === "FAIL"));

  assert.equal((await read("/api/qc-results?limit=5")).length, 5);
  assert.equal((await read("/api/instruments")).all.length, 3);
  assert.equal((await read("/api/instruments?include_inactive=true")).all.length, 4);
  assert.deepEqual((await read("/api/test-items?q=glu")).map((i) => i.item_code), ["GLU"]);

  const current = await read("/api/reagent-loads?current_only=true");
  const all = await read("/api/reagent-loads?current_only=false");
  assert.ok(current.length < all.length && current.every((l) => !l.unloaded_at));

  const history = await read("/api/qc-targets?include_history=true");
  const active = await read("/api/qc-targets");
  assert.ok(history.length > active.length && active.every((t) => !t.effective_to));

  const pending = await read("/api/qc-targets/pending-parallel-test");
  assert.ok(pending.length > 0 && pending.every((t) => t.target_source === "MANUFACTURER"));
});

test("L-J series and the relationship graph are consistent", async () => {
  const series = await read("/api/qc-results/lj?instrument_serial_number=DEMO-CHEM-01&item_code=GLU&specimen_code=B");
  assert.equal(series.length, 2);
  assert.equal(series[0].points.length, 30);
  assert.ok(series[0].points.every((p, i, all) => !i || all[i - 1].run_at <= p.run_at));

  const graph = await read("/api/er-graph?instrument_serial_number=DEMO-CHEM-01");
  assert.equal(graph.counts.assays, 5);
  const assayIds = new Set(graph.assays.map((a) => a.assay_id));
  const reagentIds = new Set(graph.reagents.map((r) => r.reagent_product_id));
  assert.ok(graph.edges.reagent_assay.every((e) => assayIds.has(e.assay_id) && reagentIds.has(e.reagent_product_id)));

  assert.equal((await demo("/api/er-graph?instrument_serial_number=NOPE")).status, 404);
  assert.equal((await demo("/api/assays/NOPE")).status, 404);
  assert.equal((await demo("/api/not-a-route")).status, 404);
});

test("the data is unmistakably synthetic", async () => {
  const instruments = (await read("/api/instruments?include_inactive=true")).all;
  assert.ok(instruments.every((i) => i.serial_number.startsWith("DEMO-") && i.instrument_name.includes("示範")));
  const sections = await read("/api/sections");
  assert.ok(sections.every((s) => s.section_name.includes("示範")));
});
