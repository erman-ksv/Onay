import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// Exercise the real Express application, including middleware ordering.
// Isolated MemoryStore fixtures send no SMS and require no external account.
const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envKeys = ["NODE_ENV", "TEZJET_STORAGE_ADAPTER", "SESSION_SECRET", "LOG_LEVEL", "TEZJET_SMS_PROVIDER", "TEZJET_SMS_SEND_ENABLED"];
const originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
let directory, production, server, baseUrl;
let sequence = 0;

before(async () => {
  process.env.NODE_ENV = "test";
  process.env.TEZJET_STORAGE_ADAPTER = "memory";
  process.env.SESSION_SECRET = "auth-cache-isolated-regression-secret";
  process.env.LOG_LEVEL = "silent";
  delete process.env.TEZJET_SMS_PROVIDER;
  process.env.TEZJET_SMS_SEND_ENABLED = "false";
  directory = await mkdtemp(path.join(apiRoot, ".auth-cache-test-"));
  const entry = path.join(directory, "production.mjs");
  await build({
    stdin: {
      contents: [
        'export { default as app } from "./src/app";',
        'export { store } from "./src/store";',
        'export { OTP_LIMITS } from "./src/utils/config";',
        'export { otpClientKey } from "./src/utils/otpRequest";',
      ].join("\n"),
      resolveDir: apiRoot, loader: "ts",
    },
    outfile: entry, bundle: true, platform: "node", format: "esm", target: "node22",
    logLevel: "silent", external: ["pg-native", "pino", "pino-http", "socket.io"],
    banner: { js: 'import { createRequire as testCreateRequire } from "node:module"; const require = testCreateRequire(import.meta.url);' },
  });
  production = await import(pathToFileURL(entry).href);
  await production.store.initialize();
  server = await new Promise(resolve => {
    const listener = production.app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}, { timeout: 30_000 });

after(async () => {
  try {
    if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

function phone() { return `+99890${String(++sequence).padStart(7, "0")}`; }
async function request(pathname, { method = "GET", token, body, raw, headers = {} } = {}) {
  const response = await fetch(baseUrl + pathname, {
    method, signal: AbortSignal.timeout(5000),
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, text, body: text ? JSON.parse(text) : undefined };
}
function noStore(result, status) {
  assert.equal(result.status, status, result.text);
  assert.equal(result.headers.get("cache-control"), "no-store");
}
async function login(endpoint = "verify-otp") {
  const phoneNumber = phone();
  await production.store.saveOtp({
    phoneNumber, code: "123456", role: "passenger", locale: "ru",
    fullName: "Cache regression", expiresAt: Date.now() + 60000,
  });
  return request("/api/auth/" + endpoint, {
    method: "POST", body: { phone_number: phoneNumber, code: "123456" },
  });
}

test("OTP request and both verification endpoints forbid storing successful responses", async () => {
  const sent = await request("/api/auth/request-otp", {
    method: "POST", body: { phone_number: phone(), role: "passenger", full_name: "Cache regression" },
  });
  noStore(sent, 202);
  for (const endpoint of ["verify-otp", "login"]) {
    const signedIn = await login(endpoint);
    noStore(signedIn, 200);
    assert.equal(typeof signedIn.body.access_token, "string");
    assert.equal(signedIn.body.user.full_name, "Cache regression");
  }
});

test("Profile GET and HEAD, profile edits, role switching and logout keep no-store", async () => {
  const signedIn = await login();
  noStore(signedIn, 200);
  const token = signedIn.body.access_token;
  const profile = await request("/api/auth/me", { token });
  noStore(profile, 200);
  assert.equal(profile.body.user.id, signedIn.body.user.id);
  const head = await request("/api/auth/me", { method: "HEAD", token });
  noStore(head, 200);
  assert.equal(head.text, "");
  noStore(await request("/api/auth/profile", { method: "PATCH", token, body: { locale: "uz" } }), 200);
  const switched = await request("/api/auth/switch-role", { method: "POST", token, body: { role: "driver" } });
  noStore(switched, 200);
  assert.equal(switched.body.user.role, "driver");
  noStore(await request("/api/auth/me", { token }), 401);
  const revoked = await request("/api/auth/logout", { method: "POST", token: switched.body.access_token });
  noStore(revoked, 204);
  assert.equal(revoked.text, "");
  noStore(await request("/api/auth/me", { token: switched.body.access_token }), 401);
});

test("Authentication, validation, malformed and oversized bodies and auth namespace misses forbid caching", async () => {
  noStore(await request("/api/auth/me"), 401);
  const head = await request("/api/auth/me", { method: "HEAD" });
  noStore(head, 401);
  assert.equal(head.text, "");
  noStore(await request("/api/auth/profile", { method: "PATCH", token: "invalid" }), 401);
  noStore(await request("/api/auth/verify-otp", { method: "POST", body: { phone_number: "invalid", code: "123456" } }), 400);
  noStore(await request("/api/auth/request-otp", { method: "POST", raw: "{" }), 400);
  noStore(await request("/api/auth/request-otp", { method: "POST", body: { padding: "x".repeat(110000) } }), 413);
  noStore(await request("/api/auth/unknown"), 404);
  noStore(await request("/API/AUTH/ME/"), 401);
});

test("Auth cache policy preserves health and existing admin response behavior", async () => {
  const health = await request("/api/healthz");
  assert.equal(health.status, 200);
  assert.notEqual(health.headers.get("cache-control"), "no-store");
  noStore(await request("/api/admin/orders"), 401);
});

test("OTP IP rate-limit early response keeps no-store and Retry-After before JSON parsing", async () => {
  const key = production.otpClientKey("127.0.0.1");
  // Fill this file's isolated budget using the actual configured store policy;
  // do not disable limits or reset counters.
  let limited = false;
  for (let index = 0; index <= production.OTP_LIMITS.ipMax; index++) {
    const result = await production.store.takeOtpIpBudget(key);
    if (!result.allowed) { limited = true; break; }
  }
  assert.equal(limited, true);
  const result = await request("/api/auth/request-otp", { method: "POST", raw: "{" });
  noStore(result, 429);
  assert.equal(result.body.error.code, "OTP_RATE_LIMITED");
  assert.ok(Number(result.headers.get("retry-after")) > 0);
  assert.equal(result.body.demo_code, undefined);
  assert.equal(result.body.access_token, undefined);
});
