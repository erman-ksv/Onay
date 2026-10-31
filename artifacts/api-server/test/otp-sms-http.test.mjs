import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// Actual HTTP application + production PostgreSQL adapter. Only the exact
// external DevSMS transport is substituted: these tests can never send SMS.
const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schema = `otp_sms_http_${randomUUID().replaceAll("-", "")}`;
const tables = ["tezjet_offer_policy", "tezjet_users", "tezjet_otp_challenges", "otp_rate_limits", "tezjet_driver_queue", "tezjet_orders", "tezjet_device_registrations", "tezjet_routes", "tezjet_admin_audit_events"];
const smsEnvKeys = ["TEZJET_SMS_PROVIDER", "TEZJET_SMS_SEND_ENABLED", "DEVSMS_API_KEY", "TEZJET_SMS_SERVICE_NAME", "TEZJET_SMS_TIMEOUT_MS"];
const envKeys = ["DATABASE_URL", "TEZJET_STORAGE_ADAPTER", "NODE_ENV", "SESSION_SECRET", "LOG_LEVEL", "ADMIN_PHONE", "TEZJET_OTP_IP_MAX", ...smsEnvKeys];
const originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
const actualFetch = globalThis.fetch;
const dummyKey = "test-only-devsms-token-never-used-on-real-network";
const endpoint = "https://devsms.uz/api/v1/sms";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let production, database, adminPool, moduleDirectory, server, baseUrl;
let schemaCreated = false;
let phoneSequence = 0;
let providerHandler;
let providerRequests = [];

before(async () => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required: SMS HTTP regressions must execute actual PostgreSQL.");
  const originalUrl = process.env.DATABASE_URL;
  const privateUrl = new URL(originalUrl);
  privateUrl.searchParams.set("options", `${privateUrl.searchParams.get("options") ?? ""} -c search_path=${schema}`.trim());
  privateUrl.searchParams.set("application_name", `otp-sms-http-${randomUUID()}`);
  process.env.DATABASE_URL = privateUrl.href;
  process.env.TEZJET_STORAGE_ADAPTER = "postgres";
  process.env.NODE_ENV = "test";
  process.env.SESSION_SECRET = "otp-sms-http-private-integration-secret-at-least-32-characters";
  process.env.LOG_LEVEL = "silent";
  delete process.env.ADMIN_PHONE;
  delete process.env.TEZJET_OTP_IP_MAX;
  for (const key of smsEnvKeys) delete process.env[key];

  // Install before importing the application, also protecting a transport that
  // captures fetch during module initialization. No external fallback exists.
  globalThis.fetch = async (input, init) => {
    const outgoing = new Request(input, init);
    if (outgoing.url !== endpoint) throw new Error("Unexpected outbound fetch was blocked by the SMS HTTP test.");
    const record = { url: outgoing.url, method: outgoing.method, headers: outgoing.headers, body: await outgoing.json(), signal: outgoing.signal };
    providerRequests.push(record);
    if (!providerHandler) throw new Error("Unexpected DevSMS send was blocked by the SMS HTTP test.");
    return providerHandler(record);
  };
  moduleDirectory = await mkdtemp(path.join(apiRoot, ".otp-sms-http-test-"));
  const entry = path.join(moduleDirectory, "production.mjs");
  await build({
    stdin: { contents: [
      'export { default as app } from "./src/app";',
      'export { PostgresStore } from "./src/store/postgresStore";',
      'export { store as runtimeStore } from "./src/store";',
      'export { pool } from "../../lib/db/src/index";',
      'export { otpRateKey } from "./src/store/otpProtection";',
      'export { otpClientKey } from "./src/utils/otpRequest";',
      'export { OTP_TTL_MS } from "./src/utils/config";',
    ].join("\n"), resolveDir: apiRoot, loader: "ts" },
    outfile: entry, bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "silent",
    external: ["pg-native", "pino"],
    banner: { js: 'import { createRequire as testCreateRequire } from "node:module"; const require = testCreateRequire(import.meta.url);' },
  });
  production = await import(pathToFileURL(entry).href);
  database = production.pool;
  adminPool = new database.constructor({ connectionString: originalUrl, max: 4 });
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  schemaCreated = true;
  for (const table of tables) await adminPool.query(`CREATE TABLE "${schema}"."${table}" (LIKE "public"."${table}" INCLUDING ALL)`);
  assert.ok(production.runtimeStore instanceof production.PostgresStore, "HTTP must use the production durable adapter.");
  await production.runtimeStore.initialize();
  server = await new Promise(resolve => { const listener = production.app.listen(0, "127.0.0.1", () => resolve(listener)); });
  baseUrl = `http://127.0.0.1:${server.address().port}/api`;
}, { timeout: 30_000 });

after(async () => {
  globalThis.fetch = actualFetch;
  try {
    if (server?.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (database) await database.end();
    if (schemaCreated && adminPool) await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
  } finally {
    if (adminPool) await adminPool.end();
    if (moduleDirectory) await rm(moduleDirectory, { recursive: true, force: true });
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

function providerReply(record, patch = {}) {
  return Response.json({ success: true, message: "Accepted by test transport", data: { id: 7321, phone: record.body.phone, status: "sent", type: "universal_otp", outcome: "sent", ...patch } });
}
async function fixture(t) {
  const phones = [];
  providerRequests = [];
  providerHandler = record => providerReply(record);
  process.env.NODE_ENV = "test";
  process.env.TEZJET_SMS_PROVIDER = "devsms";
  process.env.TEZJET_SMS_SEND_ENABLED = "true";
  process.env.DEVSMS_API_KEY = dummyKey;
  delete process.env.TEZJET_SMS_SERVICE_NAME;
  delete process.env.TEZJET_SMS_TIMEOUT_MS;
  const ipKey = production.otpRateKey("ip", production.otpClientKey("127.0.0.1"));
  await database.query("DELETE FROM otp_rate_limits WHERE key=$1", [ipKey]);
  t.after(async () => {
    providerHandler = undefined;
    process.env.NODE_ENV = "test";
    for (const key of smsEnvKeys) delete process.env[key];
    await database.query("DELETE FROM tezjet_otp_challenges WHERE phone_number = ANY($1::text[])", [phones]);
    await database.query("DELETE FROM tezjet_users WHERE phone_number = ANY($1::text[])", [phones]);
    const keys = phones.flatMap(phone => [production.otpRateKey("send", phone), production.otpRateKey("verify", phone)]);
    await database.query("DELETE FROM otp_rate_limits WHERE key = ANY($1::text[])", [[...keys, ipKey]]);
  });
  return { phone() { const phone = `+99890${String(++phoneSequence).padStart(7, "0")}`; phones.push(phone); return phone; } };
}
async function request(pathname, body) {
  // The app/provider receives guarded global fetch, while the client talks only
  // to its known loopback listener through the captured real implementation.
  const response = await actualFetch(`${baseUrl}${pathname}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, headers: response.headers, body: await response.json() };
}
const issue = phone => request("/auth/request-otp", { phone_number: phone, full_name: "SMS integration fixture", role: "passenger", locale: "uz" });
const verify = (phone, code) => request("/auth/verify-otp", { phone_number: phone, code });
async function row(phone) { return (await database.query("SELECT code, delivery_id, expires_at FROM tezjet_otp_challenges WHERE phone_number=$1", [phone])).rows[0]; }
async function sendState(phone) { return (await database.query("SELECT state FROM otp_rate_limits WHERE key=$1", [production.otpRateKey("send", phone)])).rows[0]?.state; }
function assertError(result, code) {
  assert.equal(result.status, 503, JSON.stringify(result.body));
  assert.equal(result.body.error.code, code);
  assert.equal(result.body.demo_code, undefined);
  assert.equal(result.body.code, undefined);
  assert.equal(result.body.access_token, undefined);
  assert.match(result.body.request_id, uuidPattern);
}
function assertPrivateError(result, phone, code) {
  // A random public trace UUID can coincidentally contain six OTP digits;
  // validate its format separately and inspect the actual error payload.
  const { request_id: _traceId, ...payload } = result.body;
  const serialized = JSON.stringify(payload);
  for (const secret of [dummyKey, phone, phone.slice(1), code, "provider-private-sentinel"]) if (secret) assert.equal(serialized.includes(secret), false, "SMS errors must not expose credentials, destination, OTP or upstream details.");
}

// Top-level tests are sequential: each owns this file's private IP budget and
// explicit test-only provider callback. Existing test files remain unchanged.
test("production OTP fails closed with no configured provider or explicit demo and saves no challenge", async t => {
  const f = await fixture(t);
  process.env.NODE_ENV = "production";
  for (const mode of [undefined, "demo"]) {
    if (mode === undefined) delete process.env.TEZJET_SMS_PROVIDER; else process.env.TEZJET_SMS_PROVIDER = mode;
    const phone = f.phone();
    const result = await issue(phone);
    assertError(result, "SMS_NOT_CONFIGURED");
    assertPrivateError(result, phone);
    assert.equal(await row(phone), undefined);
    assert.equal(await sendState(phone), undefined, "Missing delivery configuration must fail before phone-send admission.");
  }
  assert.equal(providerRequests.length, 0);
});

test("real provider mode in production returns no demo code and actual OTP verifies exactly once", async t => {
  const f = await fixture(t), phone = f.phone();
  process.env.NODE_ENV = "production";
  const issued = await issue(phone);
  assert.equal(issued.status, 202, JSON.stringify(issued.body));
  assert.equal(issued.body.demo_code, undefined); assert.equal(issued.body.code, undefined); assert.equal(issued.body.access_token, undefined);
  assert.equal(providerRequests.length, 1);
  const sent = providerRequests[0];
  assert.equal(sent.method, "POST"); assert.equal(sent.headers.get("authorization"), `Bearer ${dummyKey}`);
  assert.match(sent.headers.get("idempotency-key"), uuidPattern);
  assert.equal(sent.headers.get("accept"), "application/json");
  assert.match(sent.headers.get("content-type"), /^application\/json(?:;|$)/);
  assert.deepEqual(Object.keys(sent.body).sort(), ["otp", "phone"]);
  assert.equal(sent.body.phone, phone.slice(1));
  assert.deepEqual(Object.keys(sent.body.otp).sort(), ["code", "service_name", "template_type"]);
  assert.equal(sent.body.otp.template_type, 4); assert.equal(sent.body.otp.service_name, "Onay"); assert.match(sent.body.otp.code, /^\d{6}$/);
  const saved = await row(phone);
  assert.equal(saved.delivery_id, sent.headers.get("idempotency-key"));
  assert.notEqual(saved.code, sent.body.otp.code, "The persistent challenge retains a digest, never the submitted OTP.");
  const loggedIn = await verify(phone, sent.body.otp.code);
  assert.equal(loggedIn.status, 200, JSON.stringify(loggedIn.body));
  assert.equal(loggedIn.body.user.phone_number, phone); assert.equal(loggedIn.body.user.role, "passenger"); assert.equal(typeof loggedIn.body.access_token, "string");
  assert.equal(await row(phone), undefined);
  assert.equal((await verify(phone, sent.body.otp.code)).status, 401);
  assert.equal(providerRequests.length, 1, "Verification must not make another paid send request.");
});

test("real provider mode also suppresses demo codes outside production", async t => {
  const f = await fixture(t), phone = f.phone();
  const issued = await issue(phone);
  assert.equal(issued.status, 202, JSON.stringify(issued.body));
  assert.equal(issued.body.demo_code, undefined); assert.equal(issued.body.code, undefined);
  assert.equal(providerRequests.length, 1);
});

test("a definitive provider rejection cleans only its challenge and retains the consumed resend budget", async t => {
  const f = await fixture(t), phone = f.phone();
  providerHandler = () => Response.json({ success: false, error_code: "forbidden", message: `provider-private-sentinel ${dummyKey}` }, { status: 403 });
  const rejected = await issue(phone);
  assertError(rejected, "SMS_REJECTED");
  assert.equal(providerRequests.length, 1);
  assertPrivateError(rejected, phone, providerRequests[0].body.otp.code);
  assert.equal(await row(phone), undefined);
  const state = await sendState(phone);
  assert.equal(state.count, 1); assert.ok(state.nextAllowedAt > Date.now());
  const retry = await issue(phone);
  assert.equal(retry.status, 429); assert.equal(retry.body.error.code, "OTP_RATE_LIMITED");
  assert.equal(providerRequests.length, 1, "Failed sends do not refund the anti-spam budget or automatically resend.");
});

test("an unknown charged outcome never claims sent or retries, and a received valid code can still prove ownership", async t => {
  const f = await fixture(t), phone = f.phone();
  providerHandler = () => Response.json({ success: false, error_code: "provider_outcome_unknown", message: `provider-private-sentinel ${dummyKey}`, meta: { charged: true, sms_id: 7321 } }, { status: 502 });
  const unknown = await issue(phone);
  assertError(unknown, "SMS_OUTCOME_UNKNOWN"); assert.equal(providerRequests.length, 1);
  const sent = providerRequests[0]; assertPrivateError(unknown, phone, sent.body.otp.code);
  const saved = await row(phone);
  assert.equal(saved.delivery_id, sent.headers.get("idempotency-key"));
  assert.ok(Number(saved.expires_at) > Date.now() && Number(saved.expires_at) <= Date.now() + production.OTP_TTL_MS);
  assert.equal((await issue(phone)).status, 429); assert.equal(providerRequests.length, 1);
  // Unknown provider delivery is not proof of delivery. Possession of the actual
  // matching one-time code is still the only path to a real authenticated session.
  assert.equal((await verify(phone, sent.body.otp.code)).status, 200);
  assert.equal(await row(phone), undefined);
  assert.equal((await verify(phone, sent.body.otp.code)).status, 401);
});

test("a charged error cannot become definitive cleanup merely because HTTP looks like a rejection", async t => {
  const f = await fixture(t), phone = f.phone();
  providerHandler = () => Response.json({ success: false, error_code: "provider_rejected", message: "provider-private-sentinel", meta: { charged: true, sms_id: 7321 } }, { status: 422 });
  const result = await issue(phone);
  assertError(result, "SMS_OUTCOME_UNKNOWN");
  assert.equal(providerRequests.length, 1); assert.ok(await row(phone), "A potentially delivered code must not be erased as a definitive rejection.");
});

test("concurrent issuance on one phone makes one provider request and commits the other denial", { timeout: 12_000 }, async t => {
  const f = await fixture(t), phone = f.phone();
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  providerHandler = async record => { entered(); await gate; return providerReply(record); };
  const first = issue(phone);
  const timer = setTimeout(() => release(), 5_000);
  try {
    await Promise.race([started, first.then(result => { throw new Error(`Expected a pending provider call, got HTTP ${result.status}`); })]);
    const second = await issue(phone);
    assert.equal(second.status, 429, JSON.stringify(second.body)); assert.equal(second.body.error.code, "OTP_RATE_LIMITED");
    assert.equal(providerRequests.length, 1);
  } finally { clearTimeout(timer); release(); }
  const accepted = await first;
  assert.equal(accepted.status, 202, JSON.stringify(accepted.body));
  assert.equal(providerRequests.length, 1); assert.equal((await sendState(phone)).count, 1);
});

test("late rejection cleanup cannot delete a newer same-code challenge with a different delivery identity", async t => {
  const f = await fixture(t), phone = f.phone(), newerId = randomUUID();
  providerHandler = async record => {
    assert.notEqual(newerId, record.headers.get("idempotency-key"));
    await production.runtimeStore.saveOtp({ phoneNumber: phone, code: record.body.otp.code, deliveryId: newerId,
      role: "passenger", locale: "uz", fullName: "Newer delivered challenge", expiresAt: Date.now() + production.OTP_TTL_MS });
    return Response.json({ success: false, error_code: "provider_rejected", message: "provider-private-sentinel" }, { status: 422 });
  };
  const rejected = await issue(phone);
  assertError(rejected, "SMS_REJECTED");
  assert.equal(providerRequests.length, 1);
  assert.equal((await row(phone)).delivery_id, newerId, "Cleanup must compare delivery identity, not just the same OTP digits.");
  assert.equal((await verify(phone, providerRequests[0].body.otp.code)).status, 200);
});

test("unsupported real-SMS destination is refused before a provider request or phone challenge is saved", async t => {
  await fixture(t);
  const phone = "+15555550123";
  const result = await issue(phone);
  assert.equal(result.status, 422, JSON.stringify(result.body));
  assert.equal(result.body.error.code, "SMS_UNSUPPORTED_COUNTRY");
  assert.equal(providerRequests.length, 0); assert.equal(await row(phone), undefined); assert.equal(await sendState(phone), undefined);
});
