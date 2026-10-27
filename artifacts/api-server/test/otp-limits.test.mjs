import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// All PostgreSQL assertions execute production code against actual PostgreSQL.
// This schema is private to this file, including the shared IP limiter.
const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schema = `otp_limits_${randomUUID().replaceAll("-", "")}`;
const applicationName = `otp-limits-${randomUUID()}`;
const tables = ["tezjet_users", "tezjet_otp_challenges", "otp_rate_limits", "tezjet_driver_queue", "tezjet_orders", "tezjet_device_registrations", "tezjet_routes", "tezjet_admin_audit_events"];
const envKeys = ["DATABASE_URL", "TEZJET_STORAGE_ADAPTER", "NODE_ENV", "SESSION_SECRET", "LOG_LEVEL", "ADMIN_PHONE", "TEZJET_OTP_IP_MAX"];
const originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
const processes = new Set();
let production;
let database;
let adminPool;
let moduleDirectory;
let isolatedDatabaseUrl;
let server;
let baseUrl;
let store;
let otherStore;
let schemaCreated = false;
let phoneSequence = 0;

before(async () => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required: OTP protection must be tested against actual PostgreSQL.");
  const originalUrl = process.env.DATABASE_URL;
  const isolated = new URL(originalUrl);
  isolated.searchParams.set("options", `${isolated.searchParams.get("options") ?? ""} -c search_path=${schema}`.trim());
  isolated.searchParams.set("application_name", applicationName);
  isolatedDatabaseUrl = isolated.href;
  process.env.DATABASE_URL = isolatedDatabaseUrl;
  process.env.TEZJET_STORAGE_ADAPTER = "postgres";
  process.env.NODE_ENV = "test";
  process.env.SESSION_SECRET = "otp-protection-integration-secret-at-least-32-characters";
  process.env.LOG_LEVEL = "silent";
  delete process.env.ADMIN_PHONE;
  delete process.env.TEZJET_OTP_IP_MAX;
  moduleDirectory = await mkdtemp(path.join(apiRoot, ".otp-limits-test-"));
  const entry = path.join(moduleDirectory, "production.mjs");
  await build({
    stdin: {
      contents: [
        'export { PostgresStore } from "./src/store/postgresStore";',
        'export { MemoryStore } from "./src/store/memoryStore";',
        'export { pool } from "../../lib/db/src/index";',
        'export { store as runtimeStore } from "./src/store";',
        'export { otpRateKey } from "./src/store/otpProtection";',
        'export { OTP_LIMITS, OTP_TTL_MS } from "./src/utils/config";',
        'export { otpClientKey, otpPhone, otpCode } from "./src/utils/otpRequest";',
        'export { default as app } from "./src/app";',
      ].join("\n"),
      resolveDir: apiRoot, loader: "ts",
    },
    outfile: entry, bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "silent",
    external: ["pg-native", "pino"],
    banner: { js: 'import { createRequire as testCreateRequire } from "node:module"; const require = testCreateRequire(import.meta.url);' },
  });
  production = await import(pathToFileURL(entry).href);
  database = production.pool;
  adminPool = new database.constructor({ connectionString: originalUrl, max: 4 });
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  schemaCreated = true;
  for (const table of tables) {
    await adminPool.query(`CREATE TABLE "${schema}"."${table}" (LIKE "public"."${table}" INCLUDING ALL)`);
  }
  store = new production.PostgresStore();
  otherStore = new production.PostgresStore();
  assert.ok(production.runtimeStore instanceof production.PostgresStore);
  await Promise.all([store.initialize(), otherStore.initialize(), production.runtimeStore.initialize()]);
  // The actual application places the shared limiter before body parsing.
  // Express's default trust proxy remains false, including for malformed JSON.
  const app = production.app;
  server = await new Promise(resolve => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}/api`;
}, { timeout: 30_000 });

after(async () => {
  try {
    for (const child of processes) await stopChild(child);
    if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (database) await database.end();
    if (schemaCreated && adminPool) await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
  } finally {
    if (adminPool) await adminPool.end();
    if (moduleDirectory) await rm(moduleDirectory, { recursive: true, force: true });
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

function freshPhone() {
  return `+7${String(process.pid % 100_000).padStart(5, "0")}${String(++phoneSequence).padStart(5, "0")}`;
}

function challenge(phoneNumber, code = "684291", patch = {}) {
  return { phoneNumber, code, role: "passenger", locale: "ru", fullName: "OTP regression", expiresAt: Date.now() + production.OTP_TTL_MS, ...patch };
}

async function fixture(t) {
  const phones = [];
  const ipKeys = [];
  const httpIpKey = production.otpRateKey("ip", production.otpClientKey("127.0.0.1"));
  // Each top-level test is sequential and owns this file's private schema.
  // Start each HTTP scenario with its own IP budget; never reset it mid-scenario.
  await database.query("DELETE FROM otp_rate_limits WHERE key = $1", [httpIpKey]);
  t.after(async () => {
    await database.query("DELETE FROM tezjet_otp_challenges WHERE phone_number = ANY($1::text[])", [phones]);
    await database.query("DELETE FROM tezjet_users WHERE phone_number = ANY($1::text[])", [phones]);
    const phoneKeys = phones.flatMap(phone => [production.otpRateKey("send", phone), production.otpRateKey("verify", phone)]);
    await database.query("DELETE FROM otp_rate_limits WHERE key = ANY($1::text[])", [[...phoneKeys, ...ipKeys, httpIpKey]]);
  });
  return {
    phone() { const phone = freshPhone(); phones.push(phone); return phone; },
    ip() { const ip = `test-client-${randomUUID()}`; ipKeys.push(production.otpRateKey("ip", ip)); return ip; },
    httpIpKey,
  };
}

async function request(pathname, body, { url = baseUrl, headers = {} } = {}) {
  const response = await fetch(`${url}${pathname}`, {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
  });
  return { status: response.status, headers: response.headers, body: await response.json() };
}

async function rawRequest(pathname, text, headers = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: text,
  });
  return { status: response.status, headers: response.headers, body: await response.json() };
}

function assertRequestId(result) {
  assert.match(result.body.request_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.equal(result.headers.get("x-request-id"), result.body.request_id);
}

function assertLimited(result) {
  assert.equal(result.status, 429, JSON.stringify(result.body));
  assert.equal(result.body.error.code, "OTP_RATE_LIMITED");
  assertRequestId(result);
  const retry = Number(result.headers.get("retry-after"));
  assert.ok(Number.isInteger(retry) && retry > 0);
  assert.equal(result.body.retry_after_seconds, retry);
  assert.equal(result.body.access_token, undefined);
  assert.equal(result.body.demo_code, undefined);
}

async function bucket(kind, identity) {
  const { rows } = await database.query("SELECT state, expires_at FROM otp_rate_limits WHERE key = $1", [production.otpRateKey(kind, identity)]);
  return rows[0];
}

async function patchBucket(kind, identity, patch) {
  const result = await database.query("UPDATE otp_rate_limits SET state = state || $2::jsonb WHERE key = $1", [production.otpRateKey(kind, identity), JSON.stringify(patch)]);
  assert.equal(result.rowCount, 1, `Expected an existing ${kind} bucket.`);
}

async function waitForBlockedTransactions(count) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const { rows } = await adminPool.query(
      "SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND application_name = $1 AND wait_event_type = 'Lock'",
      [applicationName],
    );
    if (rows[0].count >= count) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Expected ${count} production OTP transactions waiting on actual PostgreSQL locks.`);
}

async function overlapping(keys, actions, { absent = false } = {}) {
  const blocker = await adminPool.connect();
  const pending = [];
  try {
    await blocker.query("BEGIN");
    if (absent) {
      // An absent bucket cannot be row-locked. Hold the table until both real
      // operations have entered PostgreSQL, then exercise the unique-key race.
      await blocker.query(`LOCK TABLE "${schema}".otp_rate_limits IN ACCESS EXCLUSIVE MODE`);
    } else {
      const locked = await blocker.query(`SELECT key FROM "${schema}".otp_rate_limits WHERE key = ANY($1::text[]) ORDER BY key FOR UPDATE`, [keys]);
      assert.equal(locked.rowCount, keys.length);
    }
    for (const action of actions) {
      pending.push(Promise.resolve().then(action).then(value => ({ value }), error => ({ error })));
      await waitForBlockedTransactions(pending.length);
    }
    await blocker.query("COMMIT");
    return await Promise.all(pending);
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
    await Promise.all(pending);
  }
}

function settledValues(results) {
  for (const result of results) assert.equal(result.error, undefined, result.error?.stack);
  return results.map(result => result.value);
}

test("client identities canonicalize mapped IPv4 and IPv6 /64, and invalid OTP fields are rejected", () => {
  const key = production.otpClientKey;
  assert.equal(key("192.0.2.8"), key("::ffff:192.0.2.8"));
  assert.equal(key("192.0.2.8"), key("0:0:0:0:0:ffff:c000:0208"));
  assert.equal(key("2001:db8:abcd:1234::1"), key("2001:0DB8:abcd:1234:ffff:ffff:ffff:ffff"));
  assert.notEqual(key("2001:db8:abcd:1234::1"), key("2001:db8:abcd:1235::1"));
  for (const invalid of [undefined, "", "198.51.100.1, 198.51.100.2", "spoofed"]) assert.throws(() => key(invalid));
  for (const phone of ["---", "phone+77771234567", "+00000000", "+1234567", "+1234567890123456", "+7/7771234567", null]) assert.throws(() => production.otpPhone(phone));
  assert.equal(production.otpPhone("8 (777) 123-45-67"), "+77771234567");
  assert.equal(production.otpPhone("+998 90 123 45 67"), "+998901234567");
  for (const code of ["12345", "1234567", "123x56", "123 456", 123456, null]) assert.throws(() => production.otpCode(code));
  assert.equal(production.otpCode("012345"), "012345");
});

test("MemoryStore enforces cooldown, hourly send budget, exact expiry and independent IP budget", async t => {
  const adapter = new production.MemoryStore();
  let now = 2_000_000_000_000;
  t.mock.method(Date, "now", () => now);
  const phone = freshPhone();
  assert.deepEqual(await adapter.saveOtpProtected(challenge(phone)), { allowed: true });
  const blocked = await adapter.saveOtpProtected(challenge(phone, "195837"));
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterMs, production.OTP_LIMITS.resendCooldownMs);
  assert.equal((await adapter.consumeOtpProtected(phone, "684291")).status, "verified", "A rejected resend must preserve the previous OTP.");
  for (let index = 1; index < production.OTP_LIMITS.sendMax; index++) {
    now += production.OTP_LIMITS.resendCooldownMs;
    assert.equal((await adapter.saveOtpProtected(challenge(phone))).allowed, true);
    assert.equal((await adapter.consumeOtpProtected(phone, "684291")).status, "verified");
  }
  now += production.OTP_LIMITS.resendCooldownMs;
  assert.equal((await adapter.saveOtpProtected(challenge(phone))).allowed, false, "Successful logins must not reset send budgets.");
  now += production.OTP_LIMITS.sendWindowMs;
  assert.equal((await adapter.saveOtpProtected(challenge(phone))).allowed, true);
  const expiredPhone = freshPhone();
  await adapter.saveOtp(challenge(expiredPhone, "684291", { expiresAt: now }));
  assert.equal((await adapter.consumeOtpProtected(expiredPhone, "684291")).status, "invalid", "expiresAt == now is expired.");
  for (let index = 0; index < production.OTP_LIMITS.ipMax; index++) assert.equal((await adapter.takeOtpIpBudget("memory-client")).allowed, true);
  assert.equal((await adapter.takeOtpIpBudget("memory-client")).allowed, false);
  assert.equal((await adapter.takeOtpIpBudget("other-client")).allowed, true);
  now += production.OTP_LIMITS.ipWindowMs;
  assert.equal((await adapter.takeOtpIpBudget("memory-client")).allowed, true);
});

test("both adapters retain verification failures through resend, block the fifth failure, and recover after the block", async t => {
  const f = await fixture(t);
  for (const [name, adapter] of [["memory", new production.MemoryStore()], ["postgres", store]]) {
    await t.test(name, async child => {
      const phone = f.phone();
      let now = Date.now();
      if (name === "memory") child.mock.method(Date, "now", () => now);
      assert.equal((await adapter.saveOtpProtected(challenge(phone))).allowed, true);
      for (let attempt = 1; attempt < production.OTP_LIMITS.failureMax; attempt++) {
        assert.equal((await adapter.consumeOtpProtected(phone, "000000")).status, "invalid");
      }
      if (name === "memory") now += production.OTP_LIMITS.resendCooldownMs;
      else await patchBucket("send", phone, { nextAllowedAt: 0 });
      assert.equal((await adapter.saveOtpProtected(challenge(phone, "195837", { role: "driver", locale: "uz" }))).allowed, true);
      const fifth = await adapter.consumeOtpProtected(phone, "000000");
      assert.equal(fifth.status, "limited");
      assert.ok(fifth.retryAfterMs > 0);
      assert.equal((await adapter.consumeOtpProtected(phone, "195837")).status, "limited");
      assert.equal((await adapter.saveOtpProtected(challenge(phone))).allowed, false);
      if (name === "memory") now += production.OTP_LIMITS.blockMs;
      else {
        await patchBucket("verify", phone, { windowStartedAt: 0, blockedUntil: 0 });
        await patchBucket("send", phone, { nextAllowedAt: 0 });
      }
      assert.equal((await adapter.saveOtpProtected(challenge(phone))).allowed, true);
      assert.equal((await adapter.consumeOtpProtected(phone, "684291")).status, "verified");
      assert.equal((await adapter.consumeOtpProtected(phone, "684291")).status, "invalid", "An accepted challenge is one-time.");
    });
  }
});

test("HTTP phone normalization, roles and login aliases cannot reset the failure budget", async t => {
  const f = await fixture(t);
  // Register fixture ownership for this legacy 8-prefix normalization case.
  const owned = f.phone();
  const legacy = `8${owned.slice(2)}`;
  const issued = await request("/auth/request-otp", { phone_number: legacy, full_name: "OTP regression", role: "passenger" });
  assert.equal(issued.status, 202, JSON.stringify(issued.body));
  const formatted = `${owned.slice(0, 2)} (${owned.slice(2, 5)}) ${owned.slice(5)}`;
  for (let attempt = 1; attempt < production.OTP_LIMITS.failureMax; attempt++) {
    const result = await request(attempt % 2 ? "/auth/login" : "/auth/verify-otp", { phone_number: formatted, code: "000000" });
    assert.equal(result.status, 401);
    assert.equal(result.body.error.code, "INVALID_OTP");
  }
  await patchBucket("send", owned, { nextAllowedAt: 0 });
  const reissued = await request("/auth/request-otp", { phone_number: owned, full_name: "Replacement", role: "driver", locale: "uz" });
  assert.equal(reissued.status, 202);
  assertLimited(await request("/auth/login", { phone_number: legacy, code: "000000" }));
  assertLimited(await request("/auth/verify-otp", { phone_number: owned, code: reissued.body.demo_code }));
  assertLimited(await request("/auth/request-otp", { phone_number: formatted, role: "passenger", locale: "ru" }));
  assert.equal(await store.getUserByPhone(owned), undefined);
  assert.equal((await bucket("verify", owned)).state.count, production.OTP_LIMITS.failureMax, "Failure writes must commit before returning HTTP 429.");
});

test("HTTP cooldown preserves the previous code, and successful login does not reset hourly sends", async t => {
  const f = await fixture(t);
  const phone = f.phone();
  const issued = await request("/auth/request-otp", { phone_number: phone, full_name: "OTP regression" });
  assert.equal(issued.status, 202);
  const before = await database.query("SELECT * FROM tezjet_otp_challenges WHERE phone_number = $1", [phone]);
  const callerRequestId = randomUUID();
  const limited = await request("/auth/request-otp", { phone_number: phone, role: "driver", full_name: "Altered name" }, { headers: { "x-request-id": callerRequestId } });
  assertLimited(limited);
  assert.notEqual(limited.body.request_id, callerRequestId, "The controller's phone cooldown must use a server-owned request ID.");
  const after = await database.query("SELECT * FROM tezjet_otp_challenges WHERE phone_number = $1", [phone]);
  assert.deepEqual(after.rows, before.rows);
  const verified = await request("/auth/verify-otp", { phone_number: phone, code: issued.body.demo_code });
  assert.equal(verified.status, 200);
  assert.equal(verified.body.user.role, "passenger");
  assert.equal(verified.body.user.full_name, "OTP regression");
  assert.equal((await bucket("send", phone)).state.count, 1);
  assert.equal((await bucket("ip", production.otpClientKey("127.0.0.1"))).state.count, 3, "A successful verification must retain the shared IP request budget.");
  for (let count = 1; count < production.OTP_LIMITS.sendMax; count++) {
    await patchBucket("send", phone, { nextAllowedAt: 0 });
    assert.equal((await request("/auth/request-otp", { phone_number: phone })).status, 202);
  }
  await patchBucket("send", phone, { nextAllowedAt: 0 });
  assertLimited(await request("/auth/request-otp", { phone_number: phone }));
  await patchBucket("send", phone, { windowStartedAt: 0 });
  assert.equal((await request("/auth/request-otp", { phone_number: phone })).status, 202);
});

test("HTTP malformed inputs and forbidden roles share an IP budget and spoofed forwarding headers cannot evade it", async t => {
  const f = await fixture(t);
  const phone = f.phone();
  assert.equal((await store.takeOtpIpBudget(production.otpClientKey("127.0.0.1"))).allowed, true);
  await patchBucket("ip", production.otpClientKey("127.0.0.1"), { count: production.OTP_LIMITS.ipMax - 3 });
  assert.equal((await request("/auth/request-otp", { phone_number: "---" }, { headers: { "x-forwarded-for": "198.51.100.1" } })).status, 400);
  assert.equal((await request("/auth/login", { phone_number: phone, code: "123x56" }, { headers: { forwarded: "for=198.51.100.2", "x-real-ip": "198.51.100.2" } })).status, 400);
  assert.equal((await request("/auth/request-otp", { phone_number: phone, role: "admin" }, { headers: { "x-forwarded-for": "198.51.100.3" } })).status, 403);
  assertLimited(await request("/auth/request-otp", { phone_number: phone, full_name: "OTP regression" }, { headers: { "x-forwarded-for": "198.51.100.4" } }));
  assert.equal((await bucket("ip", production.otpClientKey("127.0.0.1"))).state.count, production.OTP_LIMITS.ipMax);
  assert.equal((await database.query("SELECT count(*)::int AS count FROM tezjet_otp_challenges WHERE phone_number = $1", [phone])).rows[0].count, 0);
  assert.equal(await bucket("send", phone), undefined, "Invalid/rejected input must not allocate a phone bucket.");
});

test("HTTP malformed JSON and oversized bodies consume the shared IP budget before parsing", async t => {
  const f = await fixture(t);
  await store.takeOtpIpBudget(production.otpClientKey("127.0.0.1"));
  await patchBucket("ip", production.otpClientKey("127.0.0.1"), { count: production.OTP_LIMITS.ipMax - 2 });
  const malformed = await rawRequest("/AUTH/LOGIN/", '{"phone_number":');
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.error.code, "INVALID_JSON");
  assertRequestId(malformed);
  const oversized = await rawRequest("/auth/verify-otp", JSON.stringify({ phone_number: f.phone(), code: "123456", padding: "x".repeat(120_000) }));
  assert.equal(oversized.status, 413);
  assert.equal(oversized.body.error.code, "PAYLOAD_TOO_LARGE");
  assertRequestId(oversized);
  const callerRequestId = randomUUID();
  const limited = await rawRequest("/auth/request-otp", '{"phone_number":', { "x-request-id": callerRequestId });
  assertLimited(limited);
  assert.notEqual(limited.body.request_id, callerRequestId, "The IP gate before parsing must use a server-owned request ID.");
  assert.equal((await bucket("ip", production.otpClientKey("127.0.0.1"))).state.count, production.OTP_LIMITS.ipMax);
});

test("PostgreSQL two stores cannot bypass cooldown for an absent bucket or the last hourly send", { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  const firstPhone = f.phone();
  const first = settledValues(await overlapping([], [
    () => store.saveOtpProtected(challenge(firstPhone, "684291")),
    () => otherStore.saveOtpProtected(challenge(firstPhone, "195837")),
  ], { absent: true }));
  assert.equal(first.filter(result => result.allowed).length, 1);
  assert.equal(first.filter(result => !result.allowed).length, 1);
  const survivingCode = first[0].allowed ? "684291" : "195837";
  assert.equal((await otherStore.consumeOtpProtected(firstPhone, survivingCode)).status, "verified");
  const phone = f.phone();
  await store.saveOtpProtected(challenge(phone));
  await patchBucket("send", phone, { count: production.OTP_LIMITS.sendMax - 1, nextAllowedAt: 0 });
  const keys = [production.otpRateKey("send", phone), production.otpRateKey("verify", phone)];
  const results = settledValues(await overlapping(keys, [
    () => store.saveOtpProtected(challenge(phone, "195837")),
    () => otherStore.saveOtpProtected(challenge(phone, "539184")),
  ]));
  assert.equal(results.filter(result => result.allowed).length, 1);
  assert.equal((await bucket("send", phone)).state.count, production.OTP_LIMITS.sendMax);
});

test("PostgreSQL concurrent wrong codes preserve every failure and the fifth failure commits a shared block", { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  const phone = f.phone();
  await store.saveOtpProtected(challenge(phone));
  for (let index = 0; index < production.OTP_LIMITS.failureMax - 2; index++) assert.equal((await store.consumeOtpProtected(phone, "000000")).status, "invalid");
  const results = settledValues(await overlapping([production.otpRateKey("verify", phone)], [
    () => store.consumeOtpProtected(phone, "000000"),
    () => otherStore.consumeOtpProtected(phone, "111111"),
  ]));
  assert.deepEqual(results.map(result => result.status), ["invalid", "limited"]);
  assert.equal((await bucket("verify", phone)).state.count, production.OTP_LIMITS.failureMax);
  const restored = new production.PostgresStore();
  assert.equal((await restored.consumeOtpProtected(phone, "684291")).status, "limited");
  assert.equal((await restored.saveOtpProtected(challenge(phone))).allowed, false);
});

test("PostgreSQL two stores cannot exceed the last shared IP request", { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  const client = f.ip();
  await store.takeOtpIpBudget(client);
  await patchBucket("ip", client, { count: production.OTP_LIMITS.ipMax - 1 });
  const results = settledValues(await overlapping([production.otpRateKey("ip", client)], [
    () => store.takeOtpIpBudget(client),
    () => otherStore.takeOtpIpBudget(client),
  ]));
  assert.deepEqual(results.map(result => result.allowed), [true, false]);
  assert.equal((await bucket("ip", client)).state.count, production.OTP_LIMITS.ipMax);
  await patchBucket("ip", client, { windowStartedAt: 0 });
  assert.equal((await otherStore.takeOtpIpBudget(client)).allowed, true);
});

test("PostgreSQL correct OTP versus the fifth failure obeys both actual lock schedules", { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  for (const first of ["wrong", "correct"]) {
    await t.test(`${first} first`, async () => {
      const phone = f.phone();
      await store.saveOtpProtected(challenge(phone));
      for (let index = 1; index < production.OTP_LIMITS.failureMax; index++) await store.consumeOtpProtected(phone, "000000");
      const actions = {
        wrong: () => store.consumeOtpProtected(phone, "000000"),
        correct: () => otherStore.consumeOtpProtected(phone, "684291"),
      };
      const order = first === "wrong" ? ["wrong", "correct"] : ["correct", "wrong"];
      const results = settledValues(await overlapping([production.otpRateKey("verify", phone)], order.map(kind => actions[kind])));
      assert.deepEqual(results.map(result => result.status), first === "wrong" ? ["limited", "limited"] : ["verified", "invalid"]);
    });
  }
});

test("HTTP simultaneous correct OTPs issue one token and rotate the account session once", { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  const phone = f.phone();
  const user = await store.createUser({ role: "passenger", phoneNumber: phone, fullName: "OTP regression", locale: "ru" });
  await store.saveOtpProtected(challenge(phone));
  const results = settledValues(await overlapping([production.otpRateKey("verify", phone)], [
    () => request("/auth/verify-otp", { phone_number: phone, code: "684291" }),
    () => request("/auth/login", { phone_number: phone, code: "684291" }),
  ]));
  assert.deepEqual(results.map(result => result.status), [200, 401]);
  assert.equal(results.filter(result => typeof result.body.access_token === "string").length, 1);
  assert.equal((await store.getUser(user.id)).sessionVersion, user.sessionVersion + 1);
});

test("PostgreSQL expiry is rechecked after an OTP transaction waits for the row lock", { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  const phone = f.phone();
  await store.saveOtpProtected(challenge(phone));
  const blocker = await adminPool.connect();
  let pending;
  try {
    await blocker.query("BEGIN");
    await blocker.query(`SELECT key FROM "${schema}".otp_rate_limits WHERE key = $1 FOR UPDATE`, [production.otpRateKey("verify", phone)]);
    const { rows } = await blocker.query(`UPDATE "${schema}".tezjet_otp_challenges SET expires_at = floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint + 3000 WHERE phone_number = $1 RETURNING expires_at`, [phone]);
    const expiry = Number(rows[0].expires_at);
    // Make the still-future deadline visible before verification begins. It
    // remains unchanged throughout the lock wait: transaction-start time or
    // a pre-lock Date.now() would incorrectly accept the challenge afterward.
    await blocker.query("COMMIT");
    await blocker.query("BEGIN");
    await blocker.query(`SELECT key FROM "${schema}".otp_rate_limits WHERE key = $1 FOR UPDATE`, [production.otpRateKey("verify", phone)]);
    pending = store.consumeOtpProtected(phone, "684291");
    await waitForBlockedTransactions(1);
    const { rows: clock } = await blocker.query("SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now");
    assert.ok(Number(clock[0].now) < expiry, "Verification must enter its lock wait before the unchanged OTP deadline.");
    // PostgreSQL waits only until its own clock passes the stored deadline.
    await blocker.query("SELECT pg_sleep(GREATEST(0, ($1::bigint - floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint) / 1000.0) + 0.025)", [expiry]);
    await blocker.query("COMMIT");
    assert.equal((await pending).status, "invalid");
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
    if (pending) await pending;
  }
});

test("PostgreSQL failure while saving a challenge rolls back the associated send budget", async t => {
  const f = await fixture(t);
  const phone = f.phone();
  const name = `otp_save_failure_${randomUUID().replaceAll("-", "")}`;
  await database.query(`CREATE FUNCTION "${name}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.phone_number = '${phone}' THEN RAISE EXCEPTION 'OTP fixture write failure'; END IF; RETURN NEW; END $$`);
  await database.query(`CREATE TRIGGER "${name}" BEFORE INSERT OR UPDATE ON tezjet_otp_challenges FOR EACH ROW EXECUTE FUNCTION "${name}"()`);
  try {
    await assert.rejects(store.saveOtpProtected(challenge(phone)));
    assert.equal(await bucket("send", phone), undefined);
    assert.equal((await database.query("SELECT count(*)::int AS count FROM tezjet_otp_challenges WHERE phone_number = $1", [phone])).rows[0].count, 0);
  } finally {
    await database.query(`DROP TRIGGER "${name}" ON tezjet_otp_challenges`);
    await database.query(`DROP FUNCTION "${name}"()`);
  }
  assert.equal((await otherStore.saveOtpProtected(challenge(phone))).allowed, true);
});

test("PostgreSQL housekeeping removes expired data without deleting a live block", async t => {
  const f = await fixture(t);
  const phone = f.phone();
  const expired = f.phone();
  await store.saveOtpProtected(challenge(phone));
  for (let index = 0; index < production.OTP_LIMITS.failureMax; index++) await store.consumeOtpProtected(phone, "000000");
  await database.query("UPDATE otp_rate_limits SET expires_at = 0 WHERE key = $1", [production.otpRateKey("verify", phone)]);
  await store.saveOtp(challenge(expired, "684291", { expiresAt: 0 }));
  const staleClient = f.ip();
  await database.query("INSERT INTO otp_rate_limits (key, state, expires_at) VALUES ($1, $2, 0)", [production.otpRateKey("ip", staleClient), JSON.stringify({ windowStartedAt: 0, count: 1, nextAllowedAt: 0, blockedUntil: 0 })]);
  await otherStore.takeOtpIpBudget(f.ip());
  assert.equal(await bucket("ip", staleClient), undefined);
  assert.equal((await database.query("SELECT count(*)::int AS count FROM tezjet_otp_challenges WHERE phone_number = $1", [expired])).rows[0].count, 0);
  assert.ok((await bucket("verify", phone)).state.blockedUntil > Date.now());
  assert.equal((await otherStore.consumeOtpProtected(phone, "684291")).status, "limited");
});

test("HTTP fails closed when the shared rate table rejects writes", async t => {
  const f = await fixture(t);
  const phone = f.phone();
  await store.saveOtp(challenge(phone));
  const name = `otp_rate_failure_${randomUUID().replaceAll("-", "")}`;
  await database.query(`CREATE FUNCTION "${name}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'OTP fixture limiter failure'; END $$`);
  await database.query(`CREATE TRIGGER "${name}" BEFORE INSERT OR UPDATE ON otp_rate_limits FOR EACH ROW EXECUTE FUNCTION "${name}"()`);
  try {
    const result = await request("/auth/verify-otp", { phone_number: phone, code: "684291" });
    assert.equal(result.status, 503);
    assert.equal(result.body.error.code, "OTP_STORAGE_UNAVAILABLE");
    assert.equal(result.body.error.message, "Service temporarily unavailable");
    assertRequestId(result);
    assert.equal(result.body.access_token, undefined);
    assert.equal(await store.getUserByPhone(phone), undefined);
    assert.equal((await database.query("SELECT count(*)::int AS count FROM tezjet_otp_challenges WHERE phone_number = $1", [phone])).rows[0].count, 1);
  } finally {
    await database.query(`DROP TRIGGER "${name}" ON otp_rate_limits`);
    await database.query(`DROP FUNCTION "${name}"()`);
  }
  assert.equal((await request("/auth/verify-otp", { phone_number: phone, code: "684291" })).status, 200);
});

async function stopChild(child) {
  if (child.exitCode === null && child.signalCode === null) {
    await new Promise(resolve => { child.once("exit", resolve); child.kill("SIGTERM"); });
  }
  processes.delete(child);
}

async function startChild(port) {
  const child = spawn(process.execPath, ["--enable-source-maps", "./dist/index.mjs"], {
    cwd: apiRoot,
    env: { ...process.env, DATABASE_URL: isolatedDatabaseUrl, TEZJET_STORAGE_ADAPTER: "postgres", NODE_ENV: "test", PORT: String(port), LOG_LEVEL: "silent" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  processes.add(child);
  let output = "";
  child.stdout.on("data", data => { output += data; });
  child.stderr.on("data", data => { output += data; });
  const url = `http://127.0.0.1:${port}/api`;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`OTP child API exited: ${output}`);
    try {
      if ((await fetch(`${url}/healthz`)).ok) return { child, url };
    } catch { /* The actual API process is still starting. */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`OTP child API did not become healthy: ${output}`);
}

test("real API process restart and a second process preserve phone blocks and share the IP budget", { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  const phone = f.phone();
  const port = 57_000 + (process.pid % 1_000) * 2;
  let first = await startChild(port);
  const issued = await request("/auth/request-otp", { phone_number: phone, full_name: "OTP regression" }, { url: first.url });
  assert.equal(issued.status, 202);
  for (let count = 1; count < production.OTP_LIMITS.failureMax; count++) assert.equal((await request("/auth/login", { phone_number: phone, code: "000000" }, { url: first.url })).status, 401);
  assertLimited(await request("/auth/verify-otp", { phone_number: phone, code: "000000" }, { url: first.url }));
  await stopChild(first.child);
  first = await startChild(port);
  const second = await startChild(port + 1);
  try {
    assertLimited(await request("/auth/verify-otp", { phone_number: phone, code: issued.body.demo_code }, { url: first.url }));
    assertLimited(await request("/auth/request-otp", { phone_number: phone, role: "driver" }, { url: second.url }));
    await patchBucket("ip", production.otpClientKey("127.0.0.1"), { count: production.OTP_LIMITS.ipMax - 1 });
    assert.equal((await request("/auth/request-otp", { phone_number: "---" }, { url: first.url })).status, 400);
    assertLimited(await request("/auth/request-otp", { phone_number: f.phone() }, { url: second.url }));
    await stopChild(first.child);
    first = await startChild(port);
    assertLimited(await request("/auth/login", { phone_number: phone, code: issued.body.demo_code }, { url: first.url }));
    assert.equal(await store.getUserByPhone(phone), undefined);
  } finally {
    await stopChild(first.child);
    await stopChild(second.child);
  }
});

test("the committed OTP migration preserves legacy challenges and adds durable rate storage", async () => {
  const migrationSchema = `otp_migration_${randomUUID().replaceAll("-", "")}`;
  const sql = await readFile(path.resolve(apiRoot, "../../lib/db/drizzle/0005_otp_protection.sql"), "utf8");
  const client = await adminPool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`CREATE SCHEMA "${migrationSchema}"`);
    await client.query(`SET LOCAL search_path TO "${migrationSchema}"`);
    await client.query("CREATE TABLE tezjet_otp_challenges (phone_number text PRIMARY KEY, code text NOT NULL, role text NOT NULL, locale text NOT NULL, full_name text, expires_at bigint NOT NULL)");
    await client.query("INSERT INTO tezjet_otp_challenges VALUES ('+77771230001', 'legacy-digest', 'passenger', 'ru', 'Legacy user', 2000000000000)");
    await client.query(sql);
    assert.equal((await client.query("SELECT code FROM tezjet_otp_challenges WHERE phone_number = '+77771230001'")).rows[0].code, "legacy-digest");
    await client.query("INSERT INTO otp_rate_limits (key, state, expires_at) VALUES ($1, $2, $3)", ["test-key", JSON.stringify({ windowStartedAt: 1, count: 5, nextAllowedAt: 2, blockedUntil: 3 }), 4]);
    assert.equal((await client.query("SELECT state FROM otp_rate_limits WHERE key = 'test-key'")).rows[0].state.count, 5);
    await client.query("COMMIT");
  } finally {
    await client.query("ROLLBACK");
    client.release();
    await adminPool.query(`DROP SCHEMA IF EXISTS "${migrationSchema}" CASCADE`);
  }
});

test("invalid OTP configuration fails during process startup", { timeout: 20_000 }, async () => {
  const entry = pathToFileURL(path.join(moduleDirectory, "production.mjs")).href;
  const cases = [
    ["TEZJET_OTP_RESEND_SECONDS", "0"],
    ["TEZJET_OTP_RESEND_SECONDS", "-1"],
    ["TEZJET_OTP_RESEND_SECONDS", "1.5"],
    ["TEZJET_OTP_RESEND_SECONDS", "NaN"],
    ["TEZJET_OTP_RESEND_SECONDS", "3601"],
    ...["SEND_WINDOW_SECONDS", "SEND_MAX", "FAILURE_WINDOW_SECONDS", "FAILURE_MAX", "BLOCK_SECONDS", "IP_WINDOW_SECONDS", "IP_MAX"].map(suffix => [`TEZJET_OTP_${suffix}`, "0"]),
  ];
  for (const [name, value] of cases) {
    const child = spawn(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(entry)})`], {
      env: { ...process.env, [name]: value }, stdio: ["ignore", "pipe", "pipe"],
    });
    processes.add(child);
    let output = "";
    child.stderr.on("data", chunk => { output += chunk; });
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    processes.delete(child);
    assert.notEqual(code, 0, `${name}=${value} must not start the API.`);
    assert.ok(output.includes(`${name} must be an integer`), output);
  }
});
