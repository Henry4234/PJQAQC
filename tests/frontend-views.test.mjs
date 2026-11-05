// A page with no init entry opens blank: its menus never load. Merges can drop one line silently,
// and the script still parses, so check every page in the navigation.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path) => readFileSync(new URL(`../frontend/${path}`, import.meta.url), "utf8");

test("every page in the navigation loads something when opened", () => {
  const pages = [...read("index.html").matchAll(/data-view="([a-z-]+)"/g)].map((m) => m[1]);
  assert.ok(pages.length > 10, `expected to find the pages, got ${pages}`);

  const block = read("app.js").match(/Object\.assign\(VIEW_INIT, \{([\s\S]*?)\n\}\);/);
  assert.ok(block, "the VIEW_INIT table should exist");
  const entries = new Set([...block[1].matchAll(/^\s*"?([a-z-]+)"?:/gm)].map((m) => m[1]));
  for (const page of pages) assert.ok(entries.has(page), `${page} has no VIEW_INIT entry`);
});

test("the AI page loads its item and provider menus", () => {
  assert.match(read("app.js"), /^\s*ai: \(first\) => \{ loadAIItems\(\); if \(first\) loadAIProviders\(\); \},$/m);
});
