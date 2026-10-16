import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// Exercise real startup validation and adapters in isolated processes. No
// PostgreSQL connection or running routing provider is needed for these checks.
const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const settings = [
  ["OTP_RESEND_SECONDS", "resendCooldownMs", 60, 1000],
  ["OTP_SEND_WINDOW_SECONDS", "sendWindowMs", 3600, 1000],
  ["OTP_SEND_MAX", "sendMax", 5, 1],
  ["OTP_FAILURE_WINDOW_SECONDS", "failureWindowMs", 900, 1000],
  ["OTP_FAILURE_MAX", "failureMax", 5, 1],
  ["OTP_BLOCK_SECONDS", "blockMs", 900, 1000],
  ["OTP_IP_WINDOW_SECONDS", "ipWindowMs", 900, 1000],
  ["OTP_IP_MAX", "ipMax", 120, 1],
  ["OFFER_TIMEOUT_SECONDS", "offerTimeoutMs", 60, 1000],
];
let directory;
let entry;

before(async () => {
  directory = await mkdtemp(path.join(apiRoot, ".branding-config-test-"));
  entry = pathToFileURL(path.join(directory, "production.mjs")).href;
  await build({
    stdin: {
      contents: [
        'export { OTP_LIMITS, OFFER_TIMEOUT_MS } from "./src/utils/config";',
        'export { MemoryStore } from "./src/store/memoryStore";',
        'export { PostgresStore } from "./src/store/postgresStore";',
        'export { store } from "./src/store";',
        'export { routePickupCandidates } from "./src/services/externalPickupRouting";',
      ].join("\n"),
      resolveDir: apiRoot,
      loader: "ts",
    },
    outfile: fileURLToPath(entry),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    logLevel: "silent",
    // PostgresStore imports the database lazily. Selecting its class must not
    // connect to a database or require DATABASE_URL at module import time.
    external: ["@workspace/db", "pg-native", "pino"],
    banner: { js: 'import { createRequire as testCreateRequire } from "node:module"; const require = testCreateRequire(import.meta.url);' },
  });
}, { timeout: 30_000 });

after(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

function isolatedEnv(overrides = {}) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith("ONAY_") || name.startsWith("TEZJET_")) delete env[name];
  }
  delete env.DATABASE_URL;
  delete env.SESSION_SECRET;
  delete env.ADMIN_PHONE;
  return { ...env, NODE_ENV: "test", LOG_LEVEL: "silent", ...overrides };
}

async function run(source, env = {}) {
  const child = spawn(process.execPath, [
    "--input-type=module", "--eval",
    `const runtime = await import(${JSON.stringify(entry)});\n${source}`,
  ], {
    cwd: apiRoot,
    env: isolatedEnv(env),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Configuration child process did not exit"));
    }, 5_000);
    child.once("error", error => { clearTimeout(timeout); reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function value(result) {
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, "");
  return JSON.parse(result.stdout);
}

const configSource = 'console.log(JSON.stringify({ ...runtime.OTP_LIMITS, offerTimeoutMs: runtime.OFFER_TIMEOUT_MS }));';

function expectedSettings(readValue) {
  return Object.fromEntries(settings.map(([suffix, field, fallback, multiplier], index) =>
    [field, readValue(suffix, fallback, index) * multiplier]));
}

test("unconfigured OTP protection and offer timeout retain their validated defaults", async () => {
  assert.deepEqual(value(await run(configSource)), expectedSettings((_suffix, fallback) => fallback));
});

test("all numeric settings accept ONAY names and retain TEZJET fallback", async t => {
  for (const prefix of ["ONAY", "TEZJET"]) await t.test(prefix, async () => {
    const env = Object.fromEntries(settings.map(([suffix], index) => [`${prefix}_${suffix}`, String(index + 2)]));
    assert.deepEqual(value(await run(configSource, env)), expectedSettings((_suffix, _fallback, index) => index + 2));
  });
});

test("ONAY numeric values take precedence over conflicting invalid legacy values", async () => {
  const env = Object.fromEntries(settings.flatMap(([suffix], index) => [
    [`ONAY_${suffix}`, String(index + 11)],
    [`TEZJET_${suffix}`, "0"],
  ]));
  assert.deepEqual(value(await run(configSource, env)), expectedSettings((_suffix, _fallback, index) => index + 11));
});

test("empty or zero ONAY settings cannot fall back to valid legacy values", async t => {
  for (const [suffix] of settings) await t.test(suffix, async () => {
    const invalidValues = ["OTP_RESEND_SECONDS", "OFFER_TIMEOUT_SECONDS"].includes(suffix) ? ["", "0"] : [""];
    for (const invalid of invalidValues) {
      const result = await run(configSource, { [`ONAY_${suffix}`]: invalid, [`TEZJET_${suffix}`]: "10" });
      assert.notEqual(result.code, 0, `${suffix}=${invalid} must fail rather than using the legacy value`);
      assert.match(result.stderr, new RegExp(`ONAY_${suffix} must be an integer between 1 and`));
    }
  });
});

const storeSource = 'console.log(JSON.stringify({ adapter: runtime.store instanceof runtime.PostgresStore ? "postgres" : runtime.store instanceof runtime.MemoryStore ? "memory" : "unknown" }));';
const productionEnv = { NODE_ENV: "production", SESSION_SECRET: "onay-branding-regression-production-secret-32-characters" };
const unusedDatabaseUrl = "postgresql://unused:unused@127.0.0.1:1/unused";

test("production accepts explicit PostgreSQL activation through either name without a database connection", async t => {
  for (const env of [
    { ONAY_STORAGE_ADAPTER: "postgres" },
    { TEZJET_STORAGE_ADAPTER: "postgres" },
    { ONAY_STORAGE_ADAPTER: "postgres", TEZJET_STORAGE_ADAPTER: "memory" },
  ]) await t.test(JSON.stringify(env), async () => {
    assert.deepEqual(value(await run(storeSource, { ...productionEnv, DATABASE_URL: unusedDatabaseUrl, ...env })), { adapter: "postgres" });
  });
});

test("production storage stays fail-closed for missing, invalid or empty canonical configuration", async t => {
  for (const env of [
    {},
    { TEZJET_STORAGE_ADAPTER: "memory" },
    { ONAY_STORAGE_ADAPTER: "memory", TEZJET_STORAGE_ADAPTER: "postgres" },
    { ONAY_STORAGE_ADAPTER: "", TEZJET_STORAGE_ADAPTER: "postgres" },
    { ONAY_STORAGE_ADAPTER: "invalid", TEZJET_STORAGE_ADAPTER: "postgres" },
  ]) await t.test(JSON.stringify(env), async () => {
    const result = await run(storeSource, { ...productionEnv, DATABASE_URL: unusedDatabaseUrl, ...env });
    assert.notEqual(result.code, 0, "Production must never silently select MemoryStore");
    assert.match(result.stderr, /refusing to start with in-memory storage/);
  });
});

test("both PostgreSQL environment names still require DATABASE_URL", async t => {
  for (const prefix of ["ONAY", "TEZJET"]) await t.test(prefix, async () => {
    const result = await run(storeSource, { ...productionEnv, [`${prefix}_STORAGE_ADAPTER`]: "postgres" });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /DATABASE_URL is required/);
  });
});

test("development retains explicit adapter selection and empty canonical values suppress legacy fallback", async () => {
  assert.deepEqual(value(await run(storeSource, { DATABASE_URL: unusedDatabaseUrl })), { adapter: "memory" });
  assert.deepEqual(value(await run(storeSource, { ONAY_STORAGE_ADAPTER: "", TEZJET_STORAGE_ADAPTER: "postgres" })), { adapter: "memory" });
});

const routingSource = `
  const requests = [];
  globalThis.fetch = async url => {
    requests.push(String(url));
    return Response.json({ code: "Ok", distances: [[321]], durations: [[80]] });
  };
  try {
    const result = await runtime.routePickupCandidates([
      { driverId: "driver-1", joinedAt: 1, lastLocation: { lat: 41.31, lng: 69.27 } },
    ], { lat: 41.32, lng: 69.28 });
    console.log(JSON.stringify({ requests, result }));
  } catch (error) {
    console.log(JSON.stringify({ requests, error: { status: error.statusCode, code: error.code, message: error.message } }));
  }
`;

test("external pickup routing uses ONAY URLs, legacy fallback and canonical precedence", async t => {
  for (const [env, selected] of [
    [{ ONAY_OSRM_URL: "https://canonical.example/onay/" }, "https://canonical.example/onay"],
    [{ TEZJET_OSRM_URL: "https://legacy.example/old/" }, "https://legacy.example/old"],
    [{ ONAY_OSRM_URL: "https://canonical.example/onay/", TEZJET_OSRM_URL: "https://legacy.example/old/" }, "https://canonical.example/onay"],
  ]) await t.test(selected, async () => {
    const result = value(await run(routingSource, env));
    assert.deepEqual(result.result, [{ driverId: "driver-1", distanceMeters: 321, durationSeconds: 80 }]);
    assert.equal(result.requests.length, 1);
    assert.ok(result.requests[0].startsWith(`${selected}/table/v1/driving/`), result.requests[0]);
    assert.equal(new URL(result.requests[0]).searchParams.get("annotations"), "distance,duration");
  });
});

test("routing configuration fails closed when absent or invalid and never bypasses canonical values", async t => {
  for (const env of [
    {},
    { TEZJET_OSRM_URL: "" },
    { ONAY_OSRM_URL: "", TEZJET_OSRM_URL: "https://legacy.example/" },
    { ONAY_OSRM_URL: "https://user:SECRET_ROUTING_VALUE@canonical.example/", TEZJET_OSRM_URL: "https://legacy.example/" },
  ]) await t.test(JSON.stringify(env), async () => {
    const result = value(await run(routingSource, env));
    assert.deepEqual(result.requests, [], "Unsafe or missing configuration must not contact a provider");
    assert.deepEqual(result.error, {
      status: 503,
      code: "ROUTING_UNAVAILABLE",
      message: "Pickup road routing is unavailable",
    });
    assert.equal(JSON.stringify(result).includes("SECRET_ROUTING_VALUE"), false);
  });
});
