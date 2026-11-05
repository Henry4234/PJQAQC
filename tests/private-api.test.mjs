// The API must only be reachable through the Cloudflare Worker. These checks fail the build if a
// config change would give it another way in.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replace(/\r/g, "");

test("the API service only listens on loopback", () => {
  const unit = read("deploy/pjqaqc-api.service");
  assert.match(unit, /--host 127\.0\.0\.1 /);
  assert.doesNotMatch(unit, /0\.0\.0\.0|--host (?!127\.0\.0\.1)/);
});

test("the tunnel runs by token and never publishes a URL of its own", () => {
  const unit = read("deploy/pjqaqc-tunnel.service");
  assert.match(unit, /tunnel .*run --token-file /);
  assert.doesNotMatch(unit, /--url|--hostname/);
});

test("the Worker reaches the API through its VPC binding", () => {
  const config = read("cloudflare/wrangler.toml");
  assert.match(config, /\[\[vpc_services\]\]\s*\nbinding = "API_VPC"\s*\nservice_id = "[0-9a-f-]{36}"/);
  assert.doesNotMatch(config, /API_ORIGIN = "https:/, "API_ORIGIN must not point at a public address");
  assert.doesNotMatch(config, /EDGE_SHARED_SECRET\s*=/, "the shared secret must stay out of the repo");
});
