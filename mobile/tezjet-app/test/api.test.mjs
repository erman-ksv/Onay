import assert from "node:assert/strict";
import { test } from "node:test";

process.env.EXPO_PUBLIC_API_URL = "https://api.example.invalid";
const api = await import("../lib/api.ts");
const { request, ApiError, setApiEndpoint, validateApiEndpoint } = api;

test("API endpoints accept HTTPS and explicit local development hosts", () => {
  for (const [input, expected] of [
    [" https://api.example.invalid/ ", "https://api.example.invalid"],
    ["https://API.example.invalid:443", "https://api.example.invalid"],
    ["https://api.example.invalid:8443/", "https://api.example.invalid:8443"],
    ["http://localhost:8000/", "http://localhost:8000"],
    ["http://127.0.0.1:8000", "http://127.0.0.1:8000"],
    ["http://10.0.2.2:8000/", "http://10.0.2.2:8000"],
    ["http://[::1]:8000/", "http://[::1]:8000"],
  ]) {
    assert.equal(validateApiEndpoint(input), expected);
  }
});

test("API endpoints reject remote HTTP, credentials, and non-root URLs", () => {
  for (const input of [
    "", "api.example.invalid", "ftp://api.example.invalid", "https:api.example.invalid",
    "http://api.example.invalid", "http://192.168.1.2:8000", "http://localhost.example.invalid",
    "http://127.1", "http://2130706433", "http://0x7f000001", "http://127.0.0.2",
    "https://user:password@api.example.invalid", "https://@api.example.invalid",
    "https://api.example.invalid/api", "https://api.example.invalid/./", "https://api.example.invalid//",
    "https://api.example.invalid?debug=true", "https://api.example.invalid?",
    "https://api.example.invalid#fragment", "https://api.example.invalid#",
    "https://api.example.invalid:invalid", "https://api.exa\nmple.invalid",
  ]) {
    assert.throws(() => validateApiEndpoint(input), error =>
      error instanceof ApiError && error.code === "INVALID_API_ENDPOINT", input);
  }
});

test("changing the endpoint updates the live API binding and subsequent requests", async t => {
  t.after(() => setApiEndpoint("https://api.example.invalid"));
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  assert.equal(setApiEndpoint("https://first.example.invalid/"), "https://first.example.invalid");
  assert.equal(api.API, "https://first.example.invalid");
  assert.deepEqual(await request("/api/auth/me", "first-session"), { ok: true });
  setApiEndpoint("http://10.0.2.2:8000/");
  assert.equal(api.API, "http://10.0.2.2:8000");
  await request("/api/orders/availability", "next-session");
  assert.deepEqual(calls.map(call => call.url), [
    "https://first.example.invalid/api/auth/me",
    "http://10.0.2.2:8000/api/orders/availability",
  ]);
  assert.equal(calls[0].init.headers.Authorization, "Bearer first-session");
  assert.equal(calls[1].init.headers.Authorization, "Bearer next-session");
});

test("an invalid runtime endpoint leaves the previous endpoint in place", t => {
  t.after(() => setApiEndpoint("https://api.example.invalid"));
  setApiEndpoint("https://valid.example.invalid");
  assert.throws(() => setApiEndpoint("http://remote.example.invalid"), error =>
    error instanceof ApiError && error.code === "INVALID_API_ENDPOINT");
  assert.equal(api.API, "https://valid.example.invalid");
});

test("missing or invalid environment configuration loads safely and makes no request", async t => {
  const original = process.env.EXPO_PUBLIC_API_URL;
  t.after(() => { process.env.EXPO_PUBLIC_API_URL = original; });
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls += 1; throw new Error("should not fetch"); });
  for (const [name, value] of [["missing", ""], ["invalid", "http://remote.example.invalid"]]) {
    process.env.EXPO_PUBLIC_API_URL = value;
    const unconfigured = await import(`../lib/api.ts?${name}`);
    assert.equal(unconfigured.API, "");
    await assert.rejects(unconfigured.request("/api/auth/me"), error =>
      error instanceof unconfigured.ApiError && error.code === "API_NOT_CONFIGURED");
  }
  assert.equal(calls, 0);
});

test("NO_DRIVERS remains a typed conflict without retrying order creation", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: { code: "NO_DRIVERS", message: "Водителей пока нет" } }), { status: 409 });
  });
  await assert.rejects(request("/api/orders", "session", { method: "POST" }), error =>
    error instanceof ApiError && error.status === 409 && error.code === "NO_DRIVERS");
  assert.equal(calls, 1);
});

test("offline failures are distinguishable from an expired session", async t => {
  t.mock.method(globalThis, "fetch", async () => { throw new TypeError("fetch failed"); });
  await assert.rejects(request("/api/auth/me", "session"), error =>
    error instanceof ApiError && error.code === "NETWORK_ERROR" && error.status === undefined);
  t.mock.restoreAll();
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "Sign in again" } }), { status: 401 }));
  await assert.rejects(request("/api/auth/me", "session"), error =>
    error instanceof ApiError && error.status === 401);
});

test("a malformed successful response is not treated as a valid no-driver result", async t => {
  t.mock.method(globalThis, "fetch", async () => new Response("invalid JSON", { status: 200 }));
  await assert.rejects(request("/api/orders/availability", "session"), error =>
    error instanceof ApiError && error.code === "INVALID_RESPONSE");
});

test("empty successful responses support leaving the queue", async t => {
  t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 204 }));
  assert.equal(await request("/api/queue/leave", "session", { method: "DELETE" }), undefined);
});

test("a timed out request remains distinguishable from offline and HTTP failures", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(globalThis, "fetch", async (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  }));
  const rejected = assert.rejects(request("/api/auth/me", "session"), error =>
    error instanceof ApiError && error.code === "REQUEST_TIMEOUT" && error.status === undefined);
  t.mock.timers.tick(15_000);
  await rejected;
});

test("an empty JSON error body preserves the HTTP status", async t => {
  t.mock.method(globalThis, "fetch", async () => new Response("null", { status: 401 }));
  await assert.rejects(request("/api/auth/me", "session"), error =>
    error instanceof ApiError && error.status === 401 && error.message === "Ошибка 401");
});
