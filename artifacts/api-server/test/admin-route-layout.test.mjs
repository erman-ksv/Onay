import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// Execute the production Express app, auth middleware, and both adapters.
// Every durable assertion uses real PostgreSQL in a private schema: no mock
// query results, public-table cleanup, TRUNCATE, or skipped database tests.
const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schema = `admin_layout_${randomUUID().replaceAll("-", "")}`;
const applicationName = `admin-layout-${randomUUID()}`;
const tables = ["tezjet_users", "tezjet_otp_challenges", "otp_rate_limits", "tezjet_driver_queue", "tezjet_orders", "tezjet_device_registrations", "tezjet_routes"];
const envKeys = ["DATABASE_URL", "TEZJET_STORAGE_ADAPTER", "NODE_ENV", "SESSION_SECRET", "LOG_LEVEL"];
const originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
let moduleDirectory;
let production;
let database;
let adminPool;
let store;
let otherStore;
let server;
let baseUrl;
let schemaCreated = false;

before(async () => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required: route-layout regressions must execute real PostgreSQL.");
  const originalUrl = process.env.DATABASE_URL;
  const isolatedUrl = new URL(originalUrl);
  isolatedUrl.searchParams.set("options", `${isolatedUrl.searchParams.get("options") ?? ""} -c search_path=${schema}`.trim());
  isolatedUrl.searchParams.set("application_name", applicationName);
  process.env.DATABASE_URL = isolatedUrl.href;
  process.env.TEZJET_STORAGE_ADAPTER = "postgres";
  process.env.NODE_ENV = "production";
  process.env.SESSION_SECRET = "admin-route-layout-regression-secret-at-least-32-characters";
  process.env.LOG_LEVEL = "silent";
  moduleDirectory = await mkdtemp(path.join(apiRoot, ".admin-layout-test-"));
  const entry = path.join(moduleDirectory, "production.mjs");
  await build({
    stdin: {
      contents: [
        'export { default as app } from "./src/app";',
        'export { PostgresStore } from "./src/store/postgresStore";',
        'export { MemoryStore } from "./src/store/memoryStore";',
        'export { pool } from "../../lib/db/src/index";',
        'export { store as runtimeStore } from "./src/store";',
        'export { createAccessToken } from "./src/utils/token";',
      ].join("\n"),
      resolveDir: apiRoot, loader: "ts",
    },
    outfile: entry, bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "silent",
    external: ["pg-native", "pino", "pino-http"],
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
  assert.ok(production.runtimeStore instanceof production.PostgresStore, "The real HTTP app must use the PostgreSQL adapter.");
  await Promise.all([store.initialize(), otherStore.initialize(), production.runtimeStore.initialize()]);
  server = await new Promise(resolve => {
    const listener = production.app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}/api`;
}, { timeout: 30_000 });

after(async () => {
  try {
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

const pitaks = { aStopCode: "A", bStopCode: "B", radiusMeters: 150 };
function draftStops() {
  return [
    { code: "A", name: "Питак A", location: { lat: 42.9, lng: 71.3 } },
    { code: "C", name: "Остановка C", location: { lat: 42.91, lng: 71.34 } },
    { code: "D", name: "Остановка D" },
    { code: "B", name: "Питак B", location: { lat: 42.94, lng: 71.43 } },
  ];
}

function editStops(route) {
  return route.stops.map(({ id, code, name, location }) => ({
    id, code, name, ...(location ? { location: { lat: location.lat, lng: location.lng } } : {}),
  }));
}

function layoutBody(route, { stops = editStops(route), config = route.pitaks } = {}) {
  return {
    expected_updated_at: route.updatedAt,
    stops,
    ...(config ? { pitaks: { a_stop_code: config.aStopCode, b_stop_code: config.bStopCode, radius_meters: config.radiusMeters } } : {}),
  };
}

function layoutInput(route, { stops = editStops(route), config = route.pitaks } = {}) {
  return { expectedUpdatedAt: route.updatedAt, stops, ...(config ? { pitaks: config } : {}) };
}

async function request(pathname, { token, method = "GET", body } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
}

async function fixture(t) {
  const users = [];
  const routes = [];
  t.after(async () => {
    await database.query("DELETE FROM tezjet_routes WHERE id = ANY($1::text[])", [routes]);
    await database.query("DELETE FROM tezjet_users WHERE id = ANY($1::text[])", [users]);
  });
  const createUser = async role => {
    const user = await store.createUser({ role, fullName: "Route layout regression", phoneNumber: `layout-${randomUUID()}`, locale: "ru" });
    users.push(user.id);
    return {
      user,
      token: production.createAccessToken({ sub: user.id, role: user.role, locale: user.locale, sessionVersion: user.sessionVersion, sessionId: randomUUID() }),
    };
  };
  const admin = await createUser("admin");
  const createRoute = async () => {
    const id = `layout-${randomUUID()}`;
    routes.push(id);
    const result = await request("/admin/routes", {
      token: admin.token, method: "POST",
      body: { route_id: id, name: "Административный маршрут", price_per_stop: 735, active: false },
    });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    return result.body.route;
  };
  const empty = await createRoute();
  const save = (route, options) => request(`/admin/routes/${route.id}/layout`, { token: admin.token, method: "PUT", body: layoutBody(route, options) });
  const configured = async () => {
    const result = await save(empty, { stops: draftStops(), config: pitaks });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body.route;
  };
  return { admin, empty, createUser, createRoute, save, configured };
}

function assertCanonical(route, codes) {
  assert.deepEqual(route.stops.map(stop => stop.code), codes);
  assert.deepEqual(route.stops.map(stop => stop.sequence), codes.map((_, i) => i + 1));
  assert.deepEqual(route.stops.map(stop => stop.position), codes.map((_, i) => i + 1));
  assert.equal(new Set(route.stops.map(stop => stop.id)).size, codes.length);
}

function assertNewer(route, beforeRoute) {
  assert.ok(Date.parse(route.updatedAt) > Date.parse(beforeRoute.updatedAt), "Every successful route mutation advances the version, including same-millisecond saves.");
}

function assertError(result, status, code) {
  assert.equal(result.status, status, JSON.stringify(result.body));
  assert.equal(result.body?.error?.code, code, JSON.stringify(result.body));
}

function settlement(action) {
  return Promise.resolve().then(action).then(value => ({ value }), error => ({ error }));
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
  throw new Error(`Expected ${count} production PostgreSQL transactions waiting on the route row lock.`);
}

// Establish real lock waiters in a controlled order. A simultaneous JS start
// alone would not prove that both callers overlap at the durable write point.
async function overlapping(routeId, actions) {
  const blocker = await adminPool.connect();
  const pending = [];
  try {
    await blocker.query("BEGIN");
    await blocker.query(`SELECT id FROM "${schema}".tezjet_routes WHERE id = $1 FOR UPDATE`, [routeId]);
    for (const action of actions) {
      pending.push(settlement(action));
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

test("admin HTTP route creation and layout save persist stop geometry, A/B pitaks, and metadata after a new Store", async t => {
  const f = await fixture(t);
  assert.deepEqual(f.empty.stops, []);
  const route = await f.configured();
  assertCanonical(route, ["A", "C", "D", "B"]);
  assert.deepEqual(route.pitaks, pitaks);
  for (const stop of route.stops) assert.match(stop.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.deepEqual({ name: route.name, currency: route.currency, pricePerStopKzt: route.pricePerStopKzt, active: route.active, createdAt: route.createdAt },
    { name: f.empty.name, currency: "KZT", pricePerStopKzt: 735, active: false, createdAt: f.empty.createdAt });
  assert.equal(route.stops[0].location.lat, 42.9);
  assert.equal(route.stops[0].location.lng, 71.3);
  assert.ok(Number.isFinite(route.stops[0].location.timestamp), "Coordinate timestamps are created by the server.");
  assert.equal(route.stops[2].location, undefined, "A middle stop may have no coordinates.");
  assertNewer(route, f.empty);
  const restarted = new production.PostgresStore();
  await restarted.initialize();
  assert.deepEqual(await restarted.getRoute(route.id), route);
  const detail = await request(`/admin/routes/${route.id}`, { token: f.admin.token });
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.body.route, route);
  const { rows } = await database.query("SELECT payload, name, active, price_per_stop_kzt, updated_at FROM tezjet_routes WHERE id = $1", [route.id]);
  assert.deepEqual(rows[0].payload, route, "Layout data is durable in the existing route JSON payload.");
  assert.equal(rows[0].name, route.name);
  assert.equal(rows[0].active, route.active);
  assert.equal(rows[0].price_per_stop_kzt, route.pricePerStopKzt);
  assert.equal(rows[0].updated_at, route.updatedAt);
});

test("the actual HTTP layout endpoint permits admin and rejects unauthenticated, passenger, and driver writes without mutation", async t => {
  const f = await fixture(t);
  const route = await f.configured();
  const stops = editStops(route);
  stops[1].name = "Unauthorized rewrite";
  const body = layoutBody(route, { stops });
  for (const role of [undefined, "passenger", "driver"]) {
    const token = role ? (await f.createUser(role)).token : undefined;
    const result = await request(`/admin/routes/${route.id}/layout`, { token, method: "PUT", body });
    assertError(result, role ? 403 : 401, role ? "FORBIDDEN" : "UNAUTHORIZED");
    assert.deepEqual(await store.getRoute(route.id), route);
  }
  const saved = await f.save(route, { stops });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.route.stops[1].name, "Unauthorized rewrite");
});

test("invalid and empty HTTP coordinates reject the entire layout with the previous geometry and version intact", async t => {
  const f = await fixture(t);
  const route = await f.configured();
  for (const location of [{ lat: "", lng: 71.3 }, { lat: null, lng: 71.3 }, { lat: 91, lng: 71.3 }, { lat: 42.9, lng: -181 }, { lat: 42.9 }]) {
    const stops = editStops(route);
    stops[1].name = "Must roll back";
    stops[0].location = location;
    assertError(await f.save(route, { stops }), 400, "INVALID_COORDINATES");
    assert.deepEqual(await store.getRoute(route.id), route);
  }
  const stops = editStops(route);
  stops[0].location = { lat: -90, lng: -180 };
  stops.at(-1).location = { lat: 90, lng: 180 };
  const saved = await f.save(route, { stops });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.route.stops[0].location.lat, -90);
  assert.equal(saved.body.route.stops.at(-1).location.lng, 180);
});

test("layout stop IDs must belong to this route and duplicate IDs or normalized codes cannot replace durable stops", async t => {
  const f = await fixture(t);
  const route = await f.configured();
  const foreign = await f.createRoute();
  const foreignSaved = await f.save(foreign, { stops: draftStops(), config: pitaks });
  assert.equal(foreignSaved.status, 200);
  const cases = [
    stops => { stops[1].id = foreignSaved.body.route.stops[1].id; },
    stops => { stops[1].id = randomUUID(); },
    stops => { stops[1].id = stops[0].id; },
    stops => { stops[2].code = " c "; },
  ];
  for (const mutate of cases) {
    const stops = editStops(route);
    mutate(stops);
    assertError(await f.save(route, { stops }), 400, "INVALID_ROUTE_LAYOUT");
    assert.deepEqual(await store.getRoute(route.id), route);
  }
  const missing = await request(`/admin/routes/layout-missing-${randomUUID()}/layout`, {
    token: f.admin.token, method: "PUT", body: layoutBody(route),
  });
  assertError(missing, 404, "ROUTE_NOT_FOUND");
});

test("pitak configuration requires distinct located endpoint stops and a valid radius, with atomic validation", async t => {
  const f = await fixture(t);
  const route = await f.configured();
  const invalid = [
    { config: { ...pitaks, bStopCode: "A" } },
    { config: { ...pitaks, aStopCode: "MISSING" } },
    { config: { ...pitaks, aStopCode: "C" } },
    { config: { ...pitaks, bStopCode: "D" } },
    { stops: editStops(route).map(stop => stop.code === "B" ? { id: stop.id, code: stop.code, name: stop.name } : stop) },
  ];
  for (const options of invalid) {
    assertError(await f.save(route, options), 400, "INVALID_ROUTE_LAYOUT");
    assert.deepEqual(await store.getRoute(route.id), route);
  }
  assertError(await f.save(route, { config: { ...pitaks, radiusMeters: 0 } }), 400, "VALIDATION_ERROR");
  assert.deepEqual(await store.getRoute(route.id), route);
});

test("one layout save reorders, renames, removes, and inserts stops while preserving retained IDs and canonical order", async t => {
  const f = await fixture(t);
  const route = await f.configured();
  const [a, c, d, b] = editStops(route);
  const stops = [
    { ...b, code: " b ", name: "Начальный питак" },
    { ...d, name: "Перемещённая остановка" },
    { code: "N", name: "Новая остановка", location: { lat: 42.92, lng: 71.4 } },
    a,
  ];
  const saved = await f.save(route, { stops, config: { aStopCode: "B", bStopCode: "A", radiusMeters: 250 } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const current = saved.body.route;
  assertCanonical(current, ["B", "D", "N", "A"]);
  assert.deepEqual([current.stops[0].id, current.stops[1].id, current.stops[3].id], [b.id, d.id, a.id]);
  assert.ok(!current.stops.some(stop => stop.id === c.id));
  assert.ok(!route.stops.some(stop => stop.id === current.stops[2].id));
  assert.deepEqual(current.pitaks, { aStopCode: "B", bStopCode: "A", radiusMeters: 250 });
  assert.equal(current.pricePerStopKzt, route.pricePerStopKzt);
  assertNewer(current, route);
  assert.deepEqual(await otherStore.getRoute(route.id), current);
});

test("omitting pitaks explicitly clears the configuration and permits removal of endpoints or an empty route draft", async t => {
  const f = await fixture(t);
  const route = await f.configured();
  const saved = await f.save(route, { stops: editStops(route).slice(1, 3), config: pitaks });
  assertError(saved, 400, "INVALID_ROUTE_LAYOUT");
  assert.deepEqual(await store.getRoute(route.id), route);
  const body = layoutBody(route, { stops: editStops(route).slice(1, 3) });
  delete body.pitaks;
  const cleared = await request(`/admin/routes/${route.id}/layout`, { token: f.admin.token, method: "PUT", body });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
  assert.equal(cleared.body.route.pitaks, undefined);
  assertCanonical(cleared.body.route, ["C", "D"]);
  const empty = await f.save(cleared.body.route, { stops: [] });
  assert.equal(empty.status, 200, JSON.stringify(empty.body));
  assert.deepEqual(empty.body.route.stops, []);
  assert.equal(empty.body.route.pitaks, undefined);
});

test("stale HTTP layout versions return ROUTE_CHANGED and successful consecutive mutations advance updatedAt monotonically", async t => {
  const f = await fixture(t);
  const route = await f.configured();
  const stops = editStops(route);
  stops[1].name = "Первое сохранение";
  const first = await f.save(route, { stops });
  assert.equal(first.status, 200);
  assertNewer(first.body.route, route);
  stops[1].name = "Потерянное сохранение";
  assertError(await f.save(route, { stops }), 409, "ROUTE_CHANGED");
  assert.deepEqual(await store.getRoute(route.id), first.body.route);
  const second = await f.save(first.body.route);
  assert.equal(second.status, 200);
  assertNewer(second.body.route, first.body.route);
  const changed = await store.updateRoute(route.id, { name: "Изменённые метаданные" });
  assertNewer(changed, second.body.route);
  assertError(await f.save(second.body.route), 409, "ROUTE_CHANGED");
  assert.deepEqual(await store.getRoute(route.id), changed);
});

test("a PostgreSQL failure rolls back the full route layout and version without metadata loss", async t => {
  const f = await fixture(t);
  const route = await f.configured();
  const triggerName = `fail_layout_${randomUUID().replaceAll("-", "")}`;
  await database.query(`CREATE FUNCTION "${schema}"."${triggerName}"() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.id = '${route.id}' THEN RAISE EXCEPTION 'injected route layout rollback'; END IF;
      RETURN NEW;
    END $$`);
  await database.query(`CREATE TRIGGER "${triggerName}" BEFORE UPDATE ON "${schema}".tezjet_routes FOR EACH ROW EXECUTE FUNCTION "${schema}"."${triggerName}"()`);
  const stops = editStops(route);
  stops[1].name = "Не должно сохраниться";
  try {
    await assert.rejects(store.updateRouteLayout(route.id, layoutInput(route, { stops })), error => {
      assert.equal(error.cause?.code, "P0001");
      assert.match(error.cause?.message ?? "", /injected route layout rollback/);
      return true;
    });
    assert.deepEqual(await otherStore.getRoute(route.id), route);
  } finally {
    await database.query(`DROP TRIGGER "${triggerName}" ON "${schema}".tezjet_routes`);
    await database.query(`DROP FUNCTION "${schema}"."${triggerName}"()`);
  }
  const saved = await f.save(route, { stops });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.route.stops[1].name, "Не должно сохраниться");
});

test("overlapping PostgreSQL layout writes with one version have one winner and reject the losing geometry", { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  const route = await f.configured();
  const first = editStops(route);
  first[1].name = "Победитель";
  first[0].location.lat = 42.901;
  const second = editStops(route);
  second[1].name = "Проигравший";
  second[0].location.lat = 42.902;
  const results = await overlapping(route.id, [
    () => store.updateRouteLayout(route.id, layoutInput(route, { stops: first })),
    () => otherStore.updateRouteLayout(route.id, layoutInput(route, { stops: second })),
  ]);
  assert.ok(results[0].value);
  assert.equal(results[1].error?.statusCode, 409);
  assert.equal(results[1].error?.code, "ROUTE_CHANGED");
  const current = await store.getRoute(route.id);
  assert.deepEqual(current, results[0].value);
  assert.equal(current.stops[1].name, "Победитель");
  assert.equal(current.stops[0].location.lat, 42.901);
  assert.deepEqual(current.pitaks, pitaks);
  assertNewer(current, route);
});

test("concurrent legacy metadata updates preserve committed geometry and make an older layout version stale", { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  const route = await f.configured();
  const stops = editStops(route);
  stops[1].location = { lat: 42.915, lng: 71.345 };
  const [layout, metadata] = await overlapping(route.id, [
    () => store.updateRouteLayout(route.id, layoutInput(route, { stops })),
    () => otherStore.updateRoute(route.id, { name: "Новое имя", pricePerStopKzt: 980, active: true }),
  ]);
  assert.ok(layout.value, String(layout.error));
  assert.ok(metadata.value, String(metadata.error));
  assert.deepEqual(metadata.value.stops, layout.value.stops);
  assert.deepEqual(metadata.value.pitaks, layout.value.pitaks);
  assert.equal(metadata.value.name, "Новое имя");
  assert.equal(metadata.value.pricePerStopKzt, 980);
  assert.equal(metadata.value.active, true);
  assertNewer(metadata.value, layout.value);
  assert.deepEqual(await store.getRoute(route.id), metadata.value);

  const current = metadata.value;
  const [nextMetadata, oldLayout] = await overlapping(route.id, [
    () => store.updateRoute(route.id, { name: "Последнее имя" }),
    () => otherStore.updateRouteLayout(route.id, layoutInput(current)),
  ]);
  assert.ok(nextMetadata.value);
  assert.equal(oldLayout.error?.code, "ROUTE_CHANGED");
  assert.equal(oldLayout.error?.statusCode, 409);
  assert.deepEqual(await store.getRoute(route.id), nextMetadata.value);
  assert.deepEqual(nextMetadata.value.stops, current.stops);
  assert.deepEqual(nextMetadata.value.pitaks, current.pitaks);
});

test("legacy HTTP stop CRUD guards configured pitak endpoints while safe middle-stop changes retain geometry", async t => {
  const f = await fixture(t);
  const route = await f.configured();
  const [a, c, , b] = route.stops;
  const guarded = [
    { pathname: `/admin/routes/${route.id}/stops/${a.id}`, method: "DELETE" },
    { pathname: `/admin/routes/${route.id}/stops/${b.id}`, method: "PATCH", body: { code: "X" } },
    { pathname: `/admin/routes/${route.id}/stops/${a.id}`, method: "PATCH", body: { sequence: 3 } },
    { pathname: `/admin/routes/${route.id}/stops/${b.id}`, method: "PATCH", body: { position: 2 } },
    { pathname: `/admin/routes/${route.id}/stops`, method: "POST", body: { code: "N", name: "После питак B" } },
  ];
  for (const operation of guarded) {
    assertError(await request(operation.pathname, { token: f.admin.token, ...operation }), 409, "ROUTE_LAYOUT_EDITOR_REQUIRED");
    assert.deepEqual(await store.getRoute(route.id), route);
  }
  const renamed = await request(`/admin/routes/${route.id}/stops/${c.id}`, { token: f.admin.token, method: "PATCH", body: { name: "Новое название C" } });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
  let current = await store.getRoute(route.id);
  assert.deepEqual(current.stops[1].location, c.location);
  assert.deepEqual(current.pitaks, route.pitaks);
  assertNewer(current, route);
  const removed = await request(`/admin/routes/${route.id}/stops/${c.id}`, { token: f.admin.token, method: "DELETE" });
  assert.equal(removed.status, 204);
  current = await store.getRoute(route.id);
  assert.deepEqual(current.pitaks, pitaks);
  assert.equal(current.stops[0].id, a.id);
  assert.equal(current.stops.at(-1).id, b.id);
  assert.deepEqual(current.stops[0].location, a.location);
  assert.deepEqual(current.stops.at(-1).location, b.location);
});

test("MemoryStore saves canonical layouts with stable IDs, monotonic versions, and isolated nested snapshots", () => {
  const memory = new production.MemoryStore();
  const empty = memory.createRoute({ id: `memory-${randomUUID()}`, name: "Memory route", pricePerStopKzt: 735, active: false });
  const route = memory.updateRouteLayout(empty.id, layoutInput(empty, { stops: draftStops(), config: pitaks }));
  assertCanonical(route, ["A", "C", "D", "B"]);
  assertNewer(route, empty);
  assert.equal(route.pricePerStopKzt, 735);
  assert.equal(route.active, false);
  const snapshot = structuredClone(route);
  route.stops[0].location.lat = 0;
  route.pitaks.radiusMeters = 1;
  assert.deepEqual(memory.getRoute(route.id), snapshot, "A caller must not mutate stored nested geometry through a returned route.");
  const listed = memory.listRoutes().find(item => item.id === route.id);
  listed.stops[0].location.lng = 0;
  listed.pitaks.bStopCode = "C";
  assert.deepEqual(memory.getRoute(route.id), snapshot);
  const stops = editStops(snapshot);
  stops[1].name = "Renamed";
  const next = memory.updateRouteLayout(snapshot.id, layoutInput(snapshot, { stops }));
  assert.deepEqual(next.stops.map(stop => stop.id), snapshot.stops.map(stop => stop.id));
  assertNewer(next, snapshot);
  assert.throws(() => memory.updateRouteLayout(snapshot.id, layoutInput(snapshot)), { statusCode: 409, code: "ROUTE_CHANGED" });
  assert.deepEqual(memory.getRoute(snapshot.id), next);
  const metadata = memory.updateRoute(next.id, { name: "Metadata", pricePerStopKzt: 980 });
  assert.deepEqual(metadata.stops, next.stops);
  assert.deepEqual(metadata.pitaks, next.pitaks);
  assertNewer(metadata, next);
});

test("MemoryStore enforces finite geometry, stop ownership, pitak endpoint guards, and atomic rejection before clearing a draft", () => {
  const memory = new production.MemoryStore();
  const empty = memory.createRoute({ id: `memory-${randomUUID()}`, name: "Memory route", pricePerStopKzt: 735, active: true });
  const route = memory.updateRouteLayout(empty.id, layoutInput(empty, { stops: draftStops(), config: pitaks }));
  for (const lat of [NaN, Infinity, -Infinity, "", null]) {
    const stops = editStops(route);
    stops[0].location.lat = lat;
    assert.throws(() => memory.updateRouteLayout(route.id, layoutInput(route, { stops })), { statusCode: 400, code: "INVALID_COORDINATES" });
    assert.deepEqual(memory.getRoute(route.id), route);
  }
  const stops = editStops(route);
  stops[1].id = randomUUID();
  assert.throws(() => memory.updateRouteLayout(route.id, layoutInput(route, { stops })), { statusCode: 400, code: "INVALID_ROUTE_LAYOUT" });
  assert.throws(() => memory.updateRouteLayout(route.id, layoutInput(route, { config: { ...pitaks, bStopCode: "A" } })), { statusCode: 400, code: "INVALID_ROUTE_LAYOUT" });
  assert.throws(() => memory.deleteRouteStop(route.id, route.stops[0].id), { statusCode: 409, code: "ROUTE_LAYOUT_EDITOR_REQUIRED" });
  assert.throws(() => memory.updateRouteStop(route.id, route.stops.at(-1).id, { code: "X" }), { statusCode: 409, code: "ROUTE_LAYOUT_EDITOR_REQUIRED" });
  assert.deepEqual(memory.getRoute(route.id), route);
  const cleared = memory.updateRouteLayout(route.id, { expectedUpdatedAt: route.updatedAt, stops: [] });
  assert.equal(cleared.pitaks, undefined);
  assert.deepEqual(cleared.stops, []);
  assertNewer(cleared, route);
  assert.equal(memory.updateRouteLayout(`missing-${randomUUID()}`, layoutInput(cleared)), undefined);
});
