import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import worker from "../cloudflare/worker.mjs";

const SITE = "https://pjqaqc.example.workers.dev";
const COOKIE = "__Host-pjqaqc_session=token";
const realFetch = globalThis.fetch;
let upstreamCalls;

beforeEach(() => {
  upstreamCalls = [];
  globalThis.fetch = async (request) => {
    upstreamCalls.push(request);
    return new Response('{"ok":true}', {
      status: 200,
      headers: { "Content-Type": "application/json", "Set-Cookie": "a=b" },
    });
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

const env = (overrides = {}) => ({
  API_ORIGIN: "https://api.example.com",
  EDGE_SHARED_SECRET: "edge-secret",
  ASSETS: { fetch: async () => new Response("asset") },
  ...overrides,
});

const call = (path, init = {}, overrides = {}) =>
  worker.fetch(new Request(SITE + path, init), env(overrides));

const write = (extra = {}) => ({
  method: "POST",
  headers: { Origin: SITE, "Content-Type": "application/json", ...extra },
  body: "{}",
});

test("anonymous visitors never reach the backend", async () => {
  const session = await call("/api/auth/session");
  assert.equal(session.status, 200);
  assert.deepEqual(await session.json(), { authenticated: false });

  assert.equal((await call("/api/instruments")).status, 401);
  assert.equal((await call("/api/qc-runs", write())).status, 401);
  assert.equal((await call("/api/instruments/1", { ...write(), method: "PATCH" })).status, 401);
  assert.equal(upstreamCalls.length, 0);
});

test("static pages are served from assets", async () => {
  const response = await call("/index.html");
  assert.equal(await response.text(), "asset");
  assert.equal(upstreamCalls.length, 0);
});

test("login and signed-in requests carry the edge secret to the backend", async () => {
  const login = await call("/api/auth/login", write());
  assert.equal(login.status, 200);
  assert.equal(login.headers.get("Set-Cookie"), "a=b", "the session cookie must reach the browser");

  const read = await call("/api/instruments?x=1", { headers: { Cookie: COOKIE } });
  assert.equal(read.headers.get("Cache-Control"), "no-store");

  assert.equal(upstreamCalls.length, 2);
  assert.equal(upstreamCalls[1].url, "https://api.example.com/api/instruments?x=1");
  for (const request of upstreamCalls) {
    assert.equal(request.headers.get("X-PJQAQC-Edge"), "edge-secret");
  }
});

test("a browser cannot supply its own edge secret", async () => {
  await call("/api/instruments", { headers: { Cookie: COOKIE, "X-PJQAQC-Edge": "forged" } });
  assert.equal(upstreamCalls[0].headers.get("X-PJQAQC-Edge"), "edge-secret");
});

test("cross-origin writes are rejected even with a session cookie", async () => {
  const init = { ...write({ Cookie: COOKIE, Origin: "https://evil.example" }) };
  assert.equal((await call("/api/qc-runs", init)).status, 403);
  assert.equal((await call("/api/auth/login", write({ Origin: "https://evil.example" }))).status, 403);
  assert.equal(upstreamCalls.length, 0);
});

test("login uses its own stricter rate limit", async () => {
  const blocked = { limit: async () => ({ success: false }) };
  const allowed = { limit: async () => ({ success: true }) };
  const login = await call("/api/auth/login", write(), { LOGIN_LIMIT: blocked, API_LIMIT: allowed });
  assert.equal(login.status, 429);
  const read = await call("/api/instruments", { headers: { Cookie: COOKIE } },
    { LOGIN_LIMIT: blocked, API_LIMIT: allowed });
  assert.equal(read.status, 200);
  assert.equal(upstreamCalls.length, 1);
});

test("the site still answers when no backend is configured", async () => {
  const noBackend = { API_ORIGIN: "", EDGE_SHARED_SECRET: "" };
  assert.deepEqual(await (await call("/api/auth/session", {}, noBackend)).json(), { authenticated: false });
  assert.equal((await call("/api/auth/login", write(), noBackend)).status, 503);
  assert.equal(upstreamCalls.length, 0);
});

test("an unreachable backend returns 502 instead of throwing", async () => {
  globalThis.fetch = async () => { throw new Error("connection refused"); };
  const response = await call("/api/instruments", { headers: { Cookie: COOKIE } });
  assert.equal(response.status, 502);
});

test("a VPC binding replaces public fetch when configured", async () => {
  const viaVpc = [];
  const API_VPC = { fetch: async (request) => { viaVpc.push(request); return new Response("{}"); } };
  await call("/api/instruments", { headers: { Cookie: COOKIE } },
    { API_ORIGIN: "http://app:8000", API_VPC });
  assert.equal(viaVpc[0].url, "http://app:8000/api/instruments");
  assert.equal(upstreamCalls.length, 0);
});
