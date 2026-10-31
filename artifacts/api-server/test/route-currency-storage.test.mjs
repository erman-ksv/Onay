import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { before, after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schema = `route_currency_${randomUUID().replaceAll("-", "")}`;
const tables = ["tezjet_offer_policy", "tezjet_users", "tezjet_otp_challenges", "otp_rate_limits", "tezjet_driver_queue", "tezjet_orders", "tezjet_device_registrations", "tezjet_routes", "tezjet_admin_audit_events"];
const envKeys = ["DATABASE_URL", "TEZJET_STORAGE_ADAPTER", "NODE_ENV", "SESSION_SECRET", "LOG_LEVEL"];
const previous = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
let directory, production, database, adminPool, store, observer, createdSchema = false, phoneSequence = 0;

before(async () => {
  assert.ok(process.env.DATABASE_URL, "Real PostgreSQL is mandatory for route-currency storage and migration regressions.");
  const originalUrl = process.env.DATABASE_URL, scoped = new URL(originalUrl);
  scoped.searchParams.set("options", `${scoped.searchParams.get("options") ?? ""} -c search_path=${schema}`.trim());
  process.env.DATABASE_URL = scoped.href;
  process.env.TEZJET_STORAGE_ADAPTER = "postgres";
  process.env.NODE_ENV = "test";
  process.env.SESSION_SECRET = "route-currency-regression-secret-at-least-32-characters";
  process.env.LOG_LEVEL = "silent";
  directory = await mkdtemp(path.join(apiRoot, ".route-currency-test-"));
  const entry = path.join(directory, "production.mjs");
  await build({ stdin: { contents: [
    'export { PostgresStore } from "./src/store/postgresStore";',
    'export { MemoryStore } from "./src/store/memoryStore";',
    'export { pool } from "../../lib/db/src/index";',
  ].join("\n"), resolveDir: apiRoot, loader: "ts" }, outfile: entry, bundle: true,
  platform: "node", format: "esm", target: "node22", logLevel: "silent", external: ["pg-native"],
  banner: { js: 'import { createRequire as fixtureRequire } from "node:module"; const require = fixtureRequire(import.meta.url);' } });
  production = await import(pathToFileURL(entry).href);
  database = production.pool;
  adminPool = new database.constructor({ connectionString: originalUrl, max: 4 });
  await adminPool.query(`CREATE SCHEMA "${schema}"`); createdSchema = true;
  for (const table of tables) await adminPool.query(`CREATE TABLE "${schema}"."${table}" (LIKE public."${table}" INCLUDING ALL)`);
  store = new production.PostgresStore(); observer = new production.PostgresStore();
  await Promise.all([store.initialize(), observer.initialize()]);
}, { timeout: 30000 });

after(async () => {
  try {
    if (database) await database.end();
    if (createdSchema && adminPool) await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
  } finally {
    if (adminPool) await adminPool.end();
    if (directory) await rm(directory, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value;
  }
});

const routeInput = (currency, price) => ({ id: `currency-${randomUUID()}`, name: "Currency storage regression", active: true,
  ...(currency === "UZS" ? { currency, pricePerStop: price } : { pricePerStopKzt: price }) });
const settling = action => Promise.resolve().then(action);

test("both stores preserve legacy KZT shape and persist explicit UZS tariffs without a KZT alias", async t => {
  for (const adapter of [store, new production.MemoryStore()]) await t.test(adapter.constructor.name, async () => {
    const legacy = await adapter.createRoute(routeInput("KZT", 735));
    assert.equal(legacy.currency, "KZT"); assert.equal(legacy.pricePerStopKzt, 735);
    assert.equal(Object.hasOwn(legacy, "pricePerStop"), false, "Do not put a second tariff alias in legacy route JSON.");
    const uzs = await adapter.createRoute(routeInput("UZS", 15000));
    assert.equal(uzs.currency, "UZS"); assert.equal(uzs.pricePerStop, 15000);
    assert.equal(Object.hasOwn(uzs, "pricePerStopKzt"), false);
    const updated = await adapter.updateRoute(uzs.id, { pricePerStop: 18000 });
    assert.equal(updated.pricePerStop, 18000); assert.equal(updated.currency, "UZS");
    assert.equal(Object.hasOwn(updated, "pricePerStopKzt"), false);
    const reader = adapter instanceof production.PostgresStore ? new production.PostgresStore() : adapter;
    await reader.initialize();
    assert.deepEqual(await reader.getRoute(uzs.id), updated, "A fresh PostgreSQL store must read the same saved currency and amount.");
    if (adapter instanceof production.PostgresStore) {
      const { rows } = await database.query("SELECT currency, price_per_stop, price_per_stop_kzt, payload FROM tezjet_routes WHERE id=$1", [uzs.id]);
      assert.equal(rows[0].currency, "UZS"); assert.equal(rows[0].price_per_stop, 18000); assert.equal(rows[0].price_per_stop_kzt, null);
      assert.deepEqual(rows[0].payload, updated);
    }
    assert.deepEqual(await adapter.getRoute(legacy.id), legacy);
  });
});

test("currency changes and KZT-shaped UZS input are rejected atomically in both stores", async t => {
  for (const adapter of [store, new production.MemoryStore()]) await t.test(adapter.constructor.name, async () => {
    const legacy = await adapter.createRoute(routeInput("KZT", 500)), uzs = await adapter.createRoute(routeInput("UZS", 10000));
    await assert.rejects(settling(() => adapter.updateRoute(legacy.id, { currency: "UZS", pricePerStop: 10000 })), error => error.code === "ROUTE_CURRENCY_IMMUTABLE");
    await assert.rejects(settling(() => adapter.updateRoute(uzs.id, { currency: "KZT", pricePerStopKzt: 500 })), error => error.code === "ROUTE_CURRENCY_IMMUTABLE");
    await assert.rejects(settling(() => adapter.updateRoute(uzs.id, { pricePerStopKzt: 10000 })), error => error.code === "INVALID_ROUTE_PRICE");
    for (const input of [
      { ...routeInput("UZS", 10000), pricePerStopKzt: 10000 },
      { ...routeInput("UZS", 10000), pricePerStop: -1 },
      { ...routeInput("UZS", 10000), pricePerStop: 0.5 },
      { ...routeInput("UZS", 10000), pricePerStop: 1000000001 },
      { ...routeInput("UZS", 10000), currency: "USD" },
    ]) {
      await assert.rejects(settling(() => adapter.createRoute(input)));
      assert.equal(await adapter.getRoute(input.id), undefined);
    }
    assert.deepEqual(await adapter.getRoute(legacy.id), legacy); assert.deepEqual(await adapter.getRoute(uzs.id), uzs);
  });
});

test("audited UZS tariff changes use a neutral audit field and keep no-op versions unchanged", async t => {
  for (const adapter of [store, new production.MemoryStore()]) await t.test(adapter.constructor.name, async () => {
    const admin = await adapter.createUser({ role: "admin", fullName: "Currency reviewer", phoneNumber: `+99890${String(++phoneSequence).padStart(7, "0")}`, locale: "uz" });
    const route = await adapter.createRoute(routeInput("UZS", 12000));
    const actor = { adminId: admin.id, expectedSessionVersion: admin.sessionVersion };
    const updated = await adapter.updateRoute(route.id, { pricePerStop: 17000 }, actor);
    const events = await adapter.listAdminAuditEvents(undefined, 50, undefined, route.id);
    assert.equal(events.length, 1); assert.deepEqual(events[0].changedFields, ["pricePerStop"]);
    assert.equal(events[0].previousVersion, route.updatedAt); assert.equal(events[0].nextVersion, updated.updatedAt);
    assert.deepEqual(await adapter.updateRoute(route.id, { currency: "UZS", pricePerStop: 17000 }, actor), updated);
    assert.equal((await adapter.listAdminAuditEvents(undefined, 50, undefined, route.id)).length, 1);
  });
});

test("legacy KZT writers may update only legacy columns without making current reads stale", async () => {
  const route = await store.createRoute(routeInput("KZT", 500));
  const payload = { ...route, pricePerStopKzt: 735 };
  await database.query("UPDATE tezjet_routes SET price_per_stop_kzt=$1,payload=$2::jsonb WHERE id=$3", [735, JSON.stringify(payload), route.id]);
  const { rows } = await database.query("SELECT price_per_stop,price_per_stop_kzt FROM tezjet_routes WHERE id=$1", [route.id]);
  assert.equal(rows[0].price_per_stop, 500); assert.equal(rows[0].price_per_stop_kzt, 735);
  assert.deepEqual(await observer.getRoute(route.id), payload, "Old writer projections must not override the authoritative KZT payload.");
  await store.updateRoute(route.id, { name: "Compatible reader" });
  assert.equal((await database.query("SELECT price_per_stop FROM tezjet_routes WHERE id=$1", [route.id])).rows[0].price_per_stop, 735);
});

test("actual currency migration preserves old payloads, is repeatable and enforces currency columns", { timeout: 30000 }, async t => {
  const oldMigration = await readFile(new URL("../../../lib/db/drizzle/0000_tezjet_persistent_store.sql", import.meta.url), "utf8");
  const currencyMigration = await readFile(new URL("../../../lib/db/drizzle/0012_route_currency.sql", import.meta.url), "utf8");
  for (const seeded of [false, true]) await t.test(seeded ? "legacy database" : "empty database", async () => {
    const migrationSchema = `currency_migration_${randomUUID().replaceAll("-", "")}`, client = await adminPool.connect();
    try {
      await client.query("BEGIN"); await client.query(`CREATE SCHEMA "${migrationSchema}"`);
      await client.query(`SET LOCAL search_path TO "${migrationSchema}"`);
      await client.query(oldMigration);
      const originalRoute = { id: "legacy", currency: "KZT", pricePerStopKzt: 735, stops: [], createdAt: "old", updatedAt: "old" };
      const originalOrder = { fare: { currency: "KZT", totalKzt: 1470, pricePerStopKzt: 735 }, status: "completed" };
      if (seeded) {
        await client.query("INSERT INTO tezjet_routes(id,name,active,price_per_stop_kzt,created_at,updated_at,payload) VALUES('legacy','Legacy',true,735,'old','old',$1::jsonb)", [JSON.stringify(originalRoute)]);
        await client.query("INSERT INTO tezjet_orders(id,passenger_id,status,created_at,updated_at,payload) VALUES('old-order','old-passenger','completed','old','old',$1::jsonb)", [JSON.stringify(originalOrder)]);
      }
      await client.query(currencyMigration); await client.query(currencyMigration);
      assert.equal((await client.query("SELECT count(*)::int AS count FROM pg_constraint WHERE conrelid='tezjet_routes'::regclass AND conname='tezjet_routes_currency_pricing_check'")).rows[0].count, 1);
      if (seeded) {
        const row = (await client.query("SELECT * FROM tezjet_routes WHERE id='legacy'")).rows[0];
        assert.equal(row.currency, "KZT"); assert.equal(row.price_per_stop, 735); assert.equal(row.price_per_stop_kzt, 735);
        assert.deepEqual(row.payload, originalRoute); assert.equal(row.updated_at, "old");
        assert.deepEqual((await client.query("SELECT payload FROM tezjet_orders WHERE id='old-order'")).rows[0].payload, originalOrder);
      }
      await client.query("INSERT INTO tezjet_routes(id,name,active,currency,price_per_stop,price_per_stop_kzt,created_at,updated_at,payload) VALUES('uzs','UZS',true,'UZS',15000,NULL,'new','new','{}'::jsonb)");
      // A previous KZT binary omits both new columns; its inserts remain valid.
      await client.query("INSERT INTO tezjet_routes(id,name,active,price_per_stop_kzt,created_at,updated_at,payload) VALUES('old-writer','KZT',true,500,'new','new','{}'::jsonb)");
      for (const [currency, neutral, legacy] of [["USD", 1, null], ["UZS", null, null], ["UZS", -1, null], ["UZS", 10000, 500], ["KZT", 500, null], ["KZT", null, -1]]) {
        await client.query("SAVEPOINT invalid_currency");
        await assert.rejects(client.query("INSERT INTO tezjet_routes(id,name,active,currency,price_per_stop,price_per_stop_kzt,created_at,updated_at,payload) VALUES($1,'Invalid',true,$2,$3,$4,'new','new','{}'::jsonb)", [randomUUID(), currency, neutral, legacy]), error => error.code === "23514");
        await client.query("ROLLBACK TO SAVEPOINT invalid_currency");
      }
    } finally { await client.query("ROLLBACK"); client.release(); }
  });
});
