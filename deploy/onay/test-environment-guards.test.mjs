import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { syntheticRouteLayout, fixtureErrorCode } from "./test-fixture.mjs";
import os from "node:os";
import { postgresRestartObserved, verifyTestEnvironment, destroyTestEnvironment, assertMigrationJournalRows, createR06Connection } from "./test-environment.mjs";

test("R06 required PostgreSQL restart rejects an unchanged actual start-time receipt", () => {
  assert.throws(() => postgresRestartObserved("2026-11-17T10:00:00Z", "2026-11-17T10:00:00Z", true), { code: "POSTGRES_RESTART_NOT_OBSERVED" });
  assert.equal(postgresRestartObserved("2026-11-17T10:00:00Z", "2026-11-17T10:00:00Z"), false);
  assert.equal(postgresRestartObserved("2026-11-17T10:00:00Z", "2026-11-17T10:01:00Z", true), true);
  assert.throws(() => postgresRestartObserved("not-a-date", "2026-11-17T10:01:00Z", true), { code: "INVALID_POSTGRES_RESTART_RECEIPT" });
});

for (const [name, change] of [
  ["database identity", state => { state.environment.DATABASE_URL = "postgresql://test:synthetic@127.0.0.1/production"; }],
  ["production mode", state => { state.environment.NODE_ENV = "production"; }],
  ["SMS enabled", state => { state.environment.TEZJET_SMS_SEND_ENABLED = "true"; }],
]) test(`R06 private state rejects changed ${name} before connecting`, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "onay-r06-private-guard-"));
  const state = { databaseName: "onay_r06_0011223344556677", fixture: { price: 12000 },
    environment: { DATABASE_URL: "postgresql://test:synthetic@127.0.0.1/onay_r06_0011223344556677",
      ONAY_R06_TEST_ONLY: "true", NODE_ENV: "test", TEZJET_STORAGE_ADAPTER: "postgres", TEZJET_SMS_PROVIDER: "demo",
      TEZJET_SMS_SEND_ENABLED: "false", REQUIRE_DRIVER_APPROVAL: "true" } };
  change(state);
  try {
    await writeFile(path.join(directory, "environment.private.json"), JSON.stringify(state), { mode: 0o600 });
    await assert.rejects(verifyTestEnvironment(directory), { code: "TEST_DATABASE_IDENTITY_MISMATCH" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("R06 private state permissions and explicit destructive acknowledgment are enforced before reading credentials", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "onay-r06-file-guard-"));
  const file = path.join(directory, "environment.private.json");
  try {
    await writeFile(file, "{}", { mode: 0o600 });
    await chmod(file, 0o644);
    await assert.rejects(verifyTestEnvironment(directory), { code: "PRIVATE_FILE_PERMISSIONS_REQUIRED" });
    await assert.rejects(destroyTestEnvironment(directory), { code: "EXPLICIT_TEST_CLEANUP_ACK_REQUIRED" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test("R06 verifies all 18 actual migration hashes by insertion identity despite historical timestamp order", () => {
  const require = createRequire(new URL("../../lib/db/package.json", import.meta.url));
  const { readMigrationFiles } = require("drizzle-orm/migrator");
  const migrations = readMigrationFiles({ migrationsFolder: new URL("../../lib/db/drizzle", import.meta.url).pathname });
  assert.equal(migrations.length, 18);
  assert.ok(migrations[12].folderMillis > migrations[13].folderMillis, "exercise the actual historical nonmonotonic metadata, not invented migration fixtures");
  const rows = migrations.map((migration, index) => ({ id: index + 1, hash: migration.hash, created_at: migration.folderMillis }));
  assert.doesNotThrow(() => assertMigrationJournalRows(rows, migrations));
  for (const invalid of [rows.slice(1), [...rows, rows[0]], rows.map((row, index) => index === 12 ? { ...row, hash: rows[13].hash } : row),
    rows.map((row, index) => index === 0 ? { ...row, id: 2 } : row)]) {
    assert.throws(() => assertMigrationJournalRows(invalid, migrations), { code: "MIGRATION_JOURNAL_MISMATCH" });
  }
});

test("R06 owned connection end waits for the transport close before database cleanup can proceed", async () => {
  // Transport-only resource regression: no SQL responses, application behavior,
  // PostgreSQL migration success or business state are simulated by this test.
  const transport = new EventEmitter();
  transport._connecting = true;
  let endRequested = false;
  transport.end = () => { endRequested = true; };
  const connection = createR06Connection({ connection: transport });
  let shutdownFinished = false;
  const ending = connection.end().then(() => { shutdownFinished = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(shutdownFinished, false, "Pool.end can resolve before an idle client's socket closes; the owned connection must await its actual end event");
  assert.equal(endRequested, true);
  transport.emit("end");
  await ending;
  assert.equal(shutdownFinished, true);
});


test("R06 layout HTTP payload passes the actual production snake-case route layout reader", async () => {
  const require = createRequire(new URL("../../artifacts/api-server/package.json", import.meta.url));
  const { build } = require("esbuild");
  const directory = await mkdtemp(path.join(os.tmpdir(), "onay-r06-layout-contract-"));
  const output = path.join(directory, "layout.mjs");
  try {
    await build({ entryPoints: [new URL("../../artifacts/api-server/src/utils/routeLayout.ts", import.meta.url).pathname],
      outfile: output, bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "silent" });
    const { readRouteLayoutInput } = await import(pathToFileURL(output).href);
    const expectedUpdatedAt = "2026-11-17T17:00:00.000Z";
    const payload = syntheticRouteLayout(expectedUpdatedAt);
    const actual = readRouteLayoutInput(payload);
    assert.equal(actual.expectedUpdatedAt, expectedUpdatedAt);
    assert.deepEqual(actual.stops.map(stop => stop.code), ["A", "C", "B"]);
    assert.deepEqual(actual.pitaks, { aStopCode: "A", bStopCode: "B", radiusMeters: 175 });
    assert.throws(() => readRouteLayoutInput({ ...payload, pitaks: { aStopCode: "A", bStopCode: "B", radiusMeters: 175 } }),
      { code: "VALIDATION_ERROR", statusCode: 400 }, "production validation must continue rejecting the wrong camel-case HTTP fields");
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test("R06 failure diagnostics expose only known error codes and never server messages or arbitrary code values", () => {
  assert.equal(fixtureErrorCode({ error: { code: "VALIDATION_ERROR", message: "PRIVATE_RESPONSE_MUST_NOT_BE_ECHOED" } }), "VALIDATION_ERROR");
  assert.equal(fixtureErrorCode({ error: { code: "PRIVATE_TOKEN_MUST_NOT_BE_ECHOED" } }), "UNCLASSIFIED");
  assert.equal(fixtureErrorCode({ error: { code: { private: "PRIVATE_OBJECT" } } }), "UNCLASSIFIED");
  assert.equal(fixtureErrorCode(undefined), "UNCLASSIFIED");
});
