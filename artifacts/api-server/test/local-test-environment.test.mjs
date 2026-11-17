import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createRequire } from "node:module";
import { prepareTestEnvironment, validateTestOptions, verifyTestEnvironment, destroyTestEnvironment,
  testOnlyAcknowledgment } from "../../../deploy/onay/test-environment.mjs";

const options = patch => ({ acknowledgment: testOnlyAcknowledgment,
  adminDatabaseUrl: "postgresql://synthetic:local-only@127.0.0.1:55433/postgres",
  databaseName: "onay_r06_0011223344556677", testPricePerStop: 12000,
  runDirectory: path.join(os.tmpdir(), "onay-r06-guard-no-files"), ...patch });

// These reject synchronously before any client, network request or migration.
for (const [label, patch, code] of [
  ["missing test acknowledgment", { acknowledgment: undefined }, "TEST_ONLY_ACK_REQUIRED"],
  ["missing explicit tariff", { testPricePerStop: undefined }, "EXPLICIT_SYNTHETIC_UZS_PRICE_REQUIRED"],
  ["coerced tariff", { testPricePerStop: "12000" }, "EXPLICIT_SYNTHETIC_UZS_PRICE_REQUIRED"],
  ["nonfinite tariff", { testPricePerStop: Infinity }, "EXPLICIT_SYNTHETIC_UZS_PRICE_REQUIRED"],
  ["negative tariff", { testPricePerStop: -1 }, "EXPLICIT_SYNTHETIC_UZS_PRICE_REQUIRED"],
  ["fractional tariff", { testPricePerStop: 0.5 }, "EXPLICIT_SYNTHETIC_UZS_PRICE_REQUIRED"],
  ["too large tariff", { testPricePerStop: 1_000_000_001 }, "EXPLICIT_SYNTHETIC_UZS_PRICE_REQUIRED"],
  ["production database name", { databaseName: "onay" }, "ISOLATED_DATABASE_NAME_REQUIRED"],
  ["SQL identifier injection", { databaseName: 'onay_r06_foo";DROP DATABASE onay;' }, "ISOLATED_DATABASE_NAME_REQUIRED"],
  ["external host", { adminDatabaseUrl: "postgresql://user:secret@database.example/postgres" }, "LOCAL_DATABASE_REQUIRED"],
  ["loopback hostname suffix", { adminDatabaseUrl: "postgresql://user:secret@localhost.example/postgres" }, "LOCAL_DATABASE_REQUIRED"],
  ["multiple hosts", { adminDatabaseUrl: "postgresql://user:secret@127.0.0.1,remote.example/postgres" }, "LOCAL_DATABASE_REQUIRED"],
  ["host query override", { adminDatabaseUrl: "postgresql://user:secret@127.0.0.1/postgres?host=remote.example" }, "LOCAL_DATABASE_REQUIRED"],
  ["relative secret directory", { runDirectory: "./private" }, "PRIVATE_RUN_DIRECTORY_REQUIRED"],
]) test(`R06 rejects ${label} before connecting`, () => assert.throws(() => validateTestOptions(options(patch)), { code }));

test("R06 fresh isolated database executes all 18 migrations, real HTTP lifecycle and API restart without disclosing credentials", { timeout: 90_000 }, async t => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL required: R06 integration must use real local PostgreSQL");
  const parent = await mkdtemp(path.join(os.tmpdir(), "onay-r06-integration-"));
  const runDirectory = path.join(parent, "private-run");
  const databaseName = "onay_r06_" + randomBytes(12).toString("hex");
  let prepared = false;
  t.after(async () => {
    if (prepared) await destroyTestEnvironment(runDirectory, "DROP_OWNED_R06_TEST_DATABASE");
    await rm(parent, { recursive: true, force: true });
  });
  const preparedEnvironment = await prepareTestEnvironment(options({ adminDatabaseUrl: process.env.DATABASE_URL, databaseName, runDirectory }));
  prepared = true;
  assert.equal(preparedEnvironment.receipt.migrationCount, 18);
  assert.equal(preparedEnvironment.receipt.migrationsReappliedWithoutChange, true);
  assert.equal(preparedEnvironment.receipt.smsSent, false);
  assert.equal(preparedEnvironment.receipt.bindHost, "127.0.0.1");
  assert.match(preparedEnvironment.receipt.priceStatus, /SYNTHETIC.*NOT_OWNER_APPROVED/);
  assert.equal((await stat(runDirectory)).mode & 0o077, 0);
  const privatePath = path.join(runDirectory, "environment.private.json");
  assert.equal((await stat(privatePath)).mode & 0o077, 0);
  const privateState = JSON.parse(await readFile(privatePath, "utf8"));
  const { Client } = createRequire(new URL("../../../lib/db/package.json", import.meta.url))("pg");
  const database = new Client({ connectionString: privateState.environment.DATABASE_URL });
  try {
    await database.connect();
    const hashes = (await database.query("SELECT hash FROM drizzle.__drizzle_migrations")).rows;
    assert.equal(hashes.length, 18);
    assert.equal(new Set(hashes.map(row => row.hash)).size, 18);
    const before = (await database.query("SELECT count(*)::int AS total FROM tezjet_users")).rows[0].total;
    await assert.rejects(prepareTestEnvironment(options({ adminDatabaseUrl: process.env.DATABASE_URL, databaseName,
      runDirectory: path.join(parent, "must-not-be-created") })), { code: "EXISTING_DATABASE_REFUSED" });
    assert.equal((await database.query("SELECT count(*)::int AS total FROM tezjet_users")).rows[0].total, before);
    await assert.rejects(stat(path.join(parent, "must-not-be-created")), { code: "ENOENT" });
    const originalPrivate = await readFile(privatePath, "utf8");
    const anotherName = "onay_r06_" + randomBytes(12).toString("hex");
    await assert.rejects(prepareTestEnvironment(options({ adminDatabaseUrl: process.env.DATABASE_URL,
      databaseName: anotherName, runDirectory })), { code: "EEXIST" });
    assert.equal(await readFile(privatePath, "utf8"), originalPrivate, "an existing run directory and its private sentinel must not be overwritten");
    assert.equal((await database.query("SELECT count(*)::int AS total FROM pg_database WHERE datname=$1", [anotherName])).rows[0].total, 0);
    const wrongProof = structuredClone(privateState);
    wrongProof.cleanupProof = "0".repeat(64);
    await writeFile(privatePath, JSON.stringify(wrongProof), { mode: 0o600 });
    try {
      await assert.rejects(destroyTestEnvironment(runDirectory, "DROP_OWNED_R06_TEST_DATABASE"), { code: "TEST_DATABASE_OWNERSHIP_REQUIRED" });
      assert.equal((await database.query("SELECT count(*)::int AS total FROM tezjet_users")).rows[0].total, before);
    } finally { await writeFile(privatePath, originalPrivate, { mode: 0o600 }); }
    const lifecycle = await verifyTestEnvironment(runDirectory, { exercise: true });
    assert.equal(lifecycle.actualApiRestart, true);
    assert.equal(lifecycle.lifecycle, "PASS");
    assert.equal(lifecycle.onceOnlySeatReturn, true);
    assert.equal(lifecycle.frozenUzsHistory, true);
    assert.equal(lifecycle.activeReservationRestored, true);
    const retained = await verifyTestEnvironment(runDirectory);
    assert.equal(retained.retainedCompletedHistory, true);
    assert.equal(retained.retainedSeats, true);
    const safeReceipts = JSON.stringify([preparedEnvironment.receipt, lifecycle, retained]);
    for (const secret of [privateState.environment.DATABASE_URL, privateState.environment.SESSION_SECRET,
      ...[privateState.fixture.admin, privateState.fixture.passenger, ...privateState.fixture.drivers].flatMap(actor => [actor.phoneNumber, actor.token])]) {
      assert.equal(safeReceipts.includes(secret), false, "sanitized receipts must not contain private connection, OTP destination or token values");
    }
    await assert.rejects(destroyTestEnvironment(runDirectory, undefined), { code: "EXPLICIT_TEST_CLEANUP_ACK_REQUIRED" });
    assert.equal((await database.query("SELECT count(*)::int AS total FROM tezjet_users")).rows[0].total, 5);
  } finally { await database.end(); }
});
