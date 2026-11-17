import { createRequire } from "node:module";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { fork, execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bootstrapFixture, exerciseFixture, probeFixture } from "./test-fixture.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const dbRequire = createRequire(path.join(root, "lib/db/package.json"));
const apiRequire = createRequire(path.join(root, "artifacts/api-server/package.json"));
const databasePattern = /^onay_r06_[a-f0-9]{16,32}$/;
const deny = code => { throw Object.assign(new Error(code), { code }); };
const digest = value => createHash("sha256").update(value).digest("hex");
const privateOptions = { mode: 0o600, flag: "wx" };
export const testOnlyAcknowledgment = "ONAY_R06_TEST_ONLY";

export function createR06Connection(options) {
  // These administrative/fixture connections are sequential and individually
  // owned. Client.end waits for its socket; Pool.end may finish before idle
  // client sockets close, racing a subsequent DROP DATABASE WITH (FORCE).
  const { Client } = dbRequire("pg");
  return new Client(options);
}

export function assertMigrationJournalRows(rows, migrations) {
  // Migration timestamps are historical metadata, not insertion order: the
  // unchanged official entries 12/13 have nonmonotonic times.
  if (rows.length !== 18 || migrations.length !== 18 ||
      rows.some((row, index) => row.id !== index + 1 || row.hash !== migrations[index].hash)) deny("MIGRATION_JOURNAL_MISMATCH");
}

/** Reject unsafe inputs before opening any connection or creating any file. */
export function validateTestOptions(options) {
  if (options.acknowledgment !== testOnlyAcknowledgment) deny("TEST_ONLY_ACK_REQUIRED");
  let admin;
  try { admin = new URL(options.adminDatabaseUrl); } catch { deny("INVALID_LOCAL_TEST_DATABASE_URL"); }
  if (!["postgres:", "postgresql:"].includes(admin.protocol) ||
      !["127.0.0.1", "localhost", "[::1]"].includes(admin.hostname) ||
      !admin.username || admin.search || admin.hash || !admin.pathname.slice(1)) deny("LOCAL_DATABASE_REQUIRED");
  if (!databasePattern.test(options.databaseName ?? "")) deny("ISOLATED_DATABASE_NAME_REQUIRED");
  if (!Number.isSafeInteger(options.testPricePerStop) || options.testPricePerStop <= 0 ||
      options.testPricePerStop > 1_000_000_000) deny("EXPLICIT_SYNTHETIC_UZS_PRICE_REQUIRED");
  if (typeof options.runDirectory !== "string" || !path.isAbsolute(options.runDirectory)) deny("PRIVATE_RUN_DIRECTORY_REQUIRED");
  return { admin, databaseName: options.databaseName };
}

export async function buildTestApi() {
  const { build } = apiRequire("esbuild");
  const outfile = path.join(root, "artifacts/api-server/dist/r06-test-api.mjs");
  const result = await build({ absWorkingDir: root, entryPoints: ["deploy/onay/test-api-entry.ts"],
    outfile, bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "silent", metafile: true,
    external: ["pg-native", "pino", "pino-http", "socket.io"],
    banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' } });
  for (const input of Object.keys(result.metafile.inputs)) {
    const absolute = path.resolve(root, input);
    if (!absolute.startsWith(root + path.sep) && !absolute.includes(`${path.sep}node_modules${path.sep}`)) deny("FOREIGN_APPLICATION_SOURCE");
  }
  return { outfile, sha256: digest(await readFile(outfile)), inputCount: Object.keys(result.metafile.inputs).length };
}

export function startTestApi(bundle, environment) {
  return new Promise((resolve, reject) => {
    const child = fork(bundle, [], { env: { ...process.env, ...environment }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    // Do not echo application output: even a failed fixture must never publish
    // its telephone numbers, OTPs, authentication responses or credentials.
    child.stdout.resume(); child.stderr.resume();
    const timeout = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("TEST_API_START_TIMEOUT")); }, 15_000);
    child.once("exit", () => { clearTimeout(timeout); reject(new Error("TEST_API_START_FAILED")); });
    child.on("message", message => {
      if (!message?.ready) return;
      clearTimeout(timeout);
      if (message.host !== "127.0.0.1" || !Number.isInteger(message.port)) { child.kill("SIGTERM"); reject(new Error("TEST_API_BIND_REJECTED")); return; }
      resolve({ child, origin: `http://127.0.0.1:${message.port}`, host: message.host, pid: child.pid });
    });
  });
}
export async function stopTestApi(server) {
  if (!server || server.child.exitCode !== null || server.child.signalCode !== null) return;
  await new Promise(resolve => {
    const timer = setTimeout(() => server.child.kill("SIGKILL"), 5000);
    server.child.once("exit", () => { clearTimeout(timer); resolve(); });
    server.child.kill("SIGTERM");
  });
}

export async function prepareTestEnvironment(options) {
  const { admin, databaseName } = validateTestOptions(options);
  const parent = await realpath(path.dirname(options.runDirectory));
  const runDirectory = path.join(parent, path.basename(options.runDirectory));
  if (runDirectory === root || runDirectory.startsWith(root + path.sep)) deny("RUN_DIRECTORY_MUST_BE_OUTSIDE_CHECKOUT");
  const administrative = createR06Connection({ connectionString: admin.href });
  let created = false, connection, server;
  try {
    await administrative.connect();
    const existing = await administrative.query("SELECT 1 FROM pg_database WHERE datname=$1", [databaseName]);
    if (existing.rowCount) deny("EXISTING_DATABASE_REFUSED");
    await mkdir(runDirectory, { mode: 0o700 }); // never reuse or overwrite another run
    await administrative.query(`CREATE DATABASE "${databaseName}" TEMPLATE template0`);
    created = true;
    const database = new URL(admin.href); database.pathname = "/" + databaseName;
    connection = createR06Connection({ connectionString: database.href });
    await connection.connect();
    const { drizzle } = dbRequire("drizzle-orm/node-postgres");
    const { migrate } = dbRequire("drizzle-orm/node-postgres/migrator");
    const { readMigrationFiles } = dbRequire("drizzle-orm/migrator");
    const migrationOptions = { migrationsFolder: path.join(root, "lib/db/drizzle") };
    const migrations = readMigrationFiles(migrationOptions);
    if (migrations.length !== 18) deny("MIGRATION_SET_REVIEW_REQUIRED");
    await migrate(drizzle(connection), migrationOptions);
    const journal = await connection.query("SELECT id, hash FROM drizzle.__drizzle_migrations ORDER BY id");
    assertMigrationJournalRows(journal.rows, migrations);
    await migrate(drizzle(connection), migrationOptions);
    if ((await connection.query("SELECT count(*)::int AS total FROM drizzle.__drizzle_migrations")).rows[0].total !== 18) deny("MIGRATIONS_NOT_IDEMPOTENT");
    const runId = randomUUID(), cleanupProof = randomBytes(32).toString("hex");
    const started = (await connection.query("SELECT pg_postmaster_start_time() AS started")).rows[0].started.toISOString();
    await connection.query("CREATE TABLE onay_r06_environment (run_id uuid PRIMARY KEY, cleanup_proof text NOT NULL, created_at timestamptz NOT NULL DEFAULT now())");
    await connection.query("INSERT INTO onay_r06_environment(run_id,cleanup_proof) VALUES($1,$2)", [runId, cleanupProof]);
    let phoneSequence = 0;
    const phonePrefix = "+99890" + String(Number.parseInt(randomBytes(3).toString("hex"), 16) % 100_000).padStart(5, "0");
    const phone = () => phonePrefix + String(++phoneSequence).padStart(2, "0");
    const adminPhone = phone();
    const environment = {
      DATABASE_URL: database.href, SESSION_SECRET: randomBytes(32).toString("hex"),
      ONAY_R06_TEST_ONLY: "true", NODE_ENV: "test", TEZJET_STORAGE_ADAPTER: "postgres",
      REQUIRE_DRIVER_APPROVAL: "true", TEZJET_SMS_PROVIDER: "demo", TEZJET_SMS_SEND_ENABLED: "false",
      DEVSMS_API_KEY: "", LOG_LEVEL: "silent", ADMIN_PHONE: adminPhone,
      PYATAK_CENTER_LAT: "41.3111", PYATAK_CENTER_LNG: "69.2797",
    };
    const bundle = await buildTestApi();
    server = await startTestApi(bundle.outfile, environment);
    const fixture = await bootstrapFixture(server.origin, { price: options.testPricePerStop, adminPhone, phone });
    await stopTestApi(server); server = undefined;
    const privateState = { version: 1, databaseName, runId, cleanupProof, environment, fixture,
      bundle: bundle.outfile, bundleSha256: bundle.sha256, initialPostgresStarted: started };
    await writeFile(path.join(runDirectory, "environment.private.json"), JSON.stringify(privateState, null, 2) + "\n", privateOptions);
    const receipt = { task: "R06", state: "PREPARED_TEST_ONLY", migrationCount: 18, migrationsReappliedWithoutChange: true,
      roles: { passenger: 1, driver: 3, administrator: 1 }, approvedVehicles: 3, configuredStops: ["A", "C", "B"],
      currency: "UZS", pricePerStop: options.testPricePerStop, priceStatus: "EXPLICIT_SYNTHETIC_TEST_ONLY_NOT_OWNER_APPROVED_PHYSICAL_TARIFF",
      smsProvider: "development OTP only", smsSent: false, production: false, bindHost: "127.0.0.1",
      bundleSha256: bundle.sha256, sourceInputCount: bundle.inputCount,
      gitHead: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
      trackedSourceDirty: execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim().length > 0 };
    await writeFile(path.join(runDirectory, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n", privateOptions);
    return { runDirectory, receipt };
  } catch (error) {
    await stopTestApi(server);
    if (created) { if (connection) { await connection.end(); connection = undefined; }
      await administrative.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`); }
    throw error;
  } finally { if (connection) await connection.end(); await administrative.end(); }
}

async function readPrivateState(runDirectory) {
  const file = path.join(runDirectory, "environment.private.json");
  const info = await stat(file);
  if ((info.mode & 0o077) !== 0) deny("PRIVATE_FILE_PERMISSIONS_REQUIRED");
  const state = JSON.parse(await readFile(file, "utf8"));
  validateTestOptions({ acknowledgment: testOnlyAcknowledgment, adminDatabaseUrl: state.environment?.DATABASE_URL,
    databaseName: state.databaseName, testPricePerStop: state.fixture?.price, runDirectory: path.resolve(runDirectory) });
  if (new URL(state.environment.DATABASE_URL).pathname !== "/" + state.databaseName ||
      state.environment.ONAY_R06_TEST_ONLY !== "true" || state.environment.NODE_ENV !== "test" ||
      state.environment.TEZJET_STORAGE_ADAPTER !== "postgres" || state.environment.TEZJET_SMS_PROVIDER !== "demo" ||
      state.environment.TEZJET_SMS_SEND_ENABLED !== "false" || state.environment.REQUIRE_DRIVER_APPROVAL !== "true") deny("TEST_DATABASE_IDENTITY_MISMATCH");
  return state;
}
export function postgresRestartObserved(previous, current, required = false) {
  if (!Number.isFinite(Date.parse(previous)) || !Number.isFinite(Date.parse(current))) deny("INVALID_POSTGRES_RESTART_RECEIPT");
  const observed = Date.parse(previous) !== Date.parse(current);
  if (required && !observed) deny("POSTGRES_RESTART_NOT_OBSERVED");
  return observed;
}
export async function verifyTestEnvironment(runDirectory, { exercise = false, requirePostgresRestart = false } = {}) {
  const state = await readPrivateState(runDirectory);
  if (digest(await readFile(state.bundle)) !== state.bundleSha256) deny("TEST_RUNTIME_BUNDLE_CHANGED");
  const connection = createR06Connection({ connectionString: state.environment.DATABASE_URL });
  let server;
  try {
    await connection.connect();
    const marker = await connection.query("SELECT run_id FROM onay_r06_environment WHERE run_id=$1 AND cleanup_proof=$2", [state.runId, state.cleanupProof]);
    if (marker.rowCount !== 1) deny("TEST_DATABASE_OWNERSHIP_REQUIRED");
    server = await startTestApi(state.bundle, state.environment);
    const restarted = async () => { const before = server.pid; await stopTestApi(server); server = await startTestApi(state.bundle, state.environment); return { origin: server.origin, changed: server.pid !== before }; };
    const result = exercise ? await exerciseFixture(server.origin, state.fixture, restarted) : await probeFixture(server.origin, state.fixture);
    if (exercise) await writeFile(path.join(runDirectory, "environment.private.json"), JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
    const started = (await connection.query("SELECT pg_postmaster_start_time() AS started")).rows[0].started.toISOString();
    const receipt = { task: "R06", state: "VERIFIED_TEST_ONLY", ...result, migrationCount: 18,
      postgresRestartObserved: postgresRestartObserved(state.initialPostgresStarted, started, requirePostgresRestart),
      currency: "UZS", pricePerStop: state.fixture.price,
      priceStatus: "EXPLICIT_SYNTHETIC_TEST_ONLY_NOT_OWNER_APPROVED_PHYSICAL_TARIFF", smsSent: false, production: false,
      bindHost: server.host, bundleSha256: state.bundleSha256 };
    await writeFile(path.join(runDirectory, exercise ? "lifecycle-receipt.json" : "retained-state-receipt.json"), JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 });
    return receipt;
  } finally { await stopTestApi(server); await connection.end(); }
}

/** Only an explicitly acknowledged database created by this tool can be removed. */
export async function destroyTestEnvironment(runDirectory, acknowledgment) {
  if (acknowledgment !== "DROP_OWNED_R06_TEST_DATABASE") deny("EXPLICIT_TEST_CLEANUP_ACK_REQUIRED");
  const state = await readPrivateState(runDirectory);
  const own = createR06Connection({ connectionString: state.environment.DATABASE_URL });
  let authorized = false;
  try { await own.connect(); authorized = (await own.query("SELECT run_id FROM onay_r06_environment WHERE run_id=$1 AND cleanup_proof=$2", [state.runId, state.cleanupProof])).rowCount === 1; }
  finally { await own.end(); }
  if (!authorized) deny("TEST_DATABASE_OWNERSHIP_REQUIRED");
  const admin = new URL(state.environment.DATABASE_URL); admin.pathname = "/postgres";
  const connection = createR06Connection({ connectionString: admin.href });
  try { await connection.connect(); await connection.query(`DROP DATABASE "${state.databaseName}" WITH (FORCE)`); }
  finally { await connection.end(); }
}

async function main() {
  const command = process.argv[2];
  const args = Object.fromEntries(process.argv.slice(3).map(argument => { const equal = argument.indexOf("="); return [argument.slice(0, equal), argument.slice(equal + 1)]; }));
  if (command === "prepare") {
    const { receipt } = await prepareTestEnvironment({ acknowledgment: args["--ack"], adminDatabaseUrl: args["--admin-env"] === "DATABASE_URL" ? process.env.DATABASE_URL : process.env.ONAY_R06_ADMIN_DATABASE_URL,
      databaseName: args["--database"], runDirectory: args["--run-directory"], testPricePerStop: Number(args["--test-price-per-stop"]) });
    console.log(JSON.stringify(receipt));
  } else if (command === "exercise" || command === "probe") {
    console.log(JSON.stringify(await verifyTestEnvironment(args["--run-directory"], { exercise: command === "exercise", requirePostgresRestart: args["--require-postgres-restart"] === "true" })));
  } else if (command === "destroy") {
    await destroyTestEnvironment(args["--run-directory"], args["--ack"]); console.log("OWNED_R06_TEST_DATABASE_REMOVED");
  } else deny("USAGE_PREPARE_EXERCISE_PROBE_DESTROY");
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { const code = typeof error?.code === "string" && /^[A-Z_]{3,80}$/.test(error.code) ? error.code : "R06_TEST_OPERATION_FAILED";
    console.error(code); process.exitCode = 1; });
}
