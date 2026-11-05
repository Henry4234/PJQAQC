// QC results and calibration events are append-only audit records. These checks read every
// migration, so a later migration cannot quietly give the app permission to change them.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

const AUDIT_TABLES = [
  "qc_runs", "qc_results", "qc_result_reagents",
  "calibration_events", "calibration_event_assays", "calibration_event_reagents",
];
const MIGRATIONS = new URL("../supabase/migrations/", import.meta.url);
const sql = readdirSync(MIGRATIONS)
  .filter((name) => name.endsWith(".sql"))
  .map((name) => readFileSync(new URL(name, MIGRATIONS), "utf8"))
  .join("\n")
  .replace(/\r/g, "");

const grants = [...sql.matchAll(/GRANT\s+([A-Z, ]+?)\s+ON\s+([\s\S]+?)\s+TO\s+pjqaqc_app\s*;/g)].map((m) => ({
  privileges: m[1].split(",").map((p) => p.trim()),
  tables: m[2].split(",").map((t) => t.trim()),
}));

test("the app role can add to audit tables but never change them", () => {
  assert.ok(grants.length >= 4, "expected to find the app role's grants");
  for (const { privileges, tables } of grants) {
    if (privileges.every((p) => p === "SELECT" || p === "INSERT")) continue;
    assert.ok(!tables.some((t) => t.startsWith("ALL ")), `${privileges} granted on every table`);
    for (const table of AUDIT_TABLES) {
      assert.ok(!tables.includes(table), `${privileges} must not be granted on ${table}`);
    }
  }
  for (const table of AUDIT_TABLES) {
    assert.ok(
      grants.some((g) => g.privileges.includes("INSERT") && g.tables.includes(table)),
      `${table} should still accept new records`,
    );
  }
});

test("deleting master data cannot cascade into QC runs or results", () => {
  for (const table of ["qc_runs", "qc_results"]) {
    const body = sql.match(new RegExp(`CREATE TABLE\\s+${table}\\s*\\(([\\s\\S]*?)\\n\\)`));
    assert.ok(body, `expected to find ${table}`);
    assert.ok(body[1].includes("REFERENCES"), `${table} should reference its parents`);
    assert.ok(!/ON DELETE (CASCADE|SET)/.test(body[1]), `${table} must not lose rows with its parents`);
  }
});
