import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { postgresRestartObserved, verifyTestEnvironment, destroyTestEnvironment } from "./test-environment.mjs";

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
