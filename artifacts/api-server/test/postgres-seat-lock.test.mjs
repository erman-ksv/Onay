import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// These tests execute the production adapter and controllers against real
// PostgreSQL. A private schema prevents expiry scans or rollback triggers from
// touching rows owned by the concurrent API scenario test.
const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schema = `seat_lock_test_${randomUUID().replaceAll("-", "")}`;
const applicationName = `seat-lock-${randomUUID()}`;
const tables = ["tezjet_users", "tezjet_otp_challenges", "otp_rate_limits", "tezjet_driver_queue", "tezjet_orders", "tezjet_device_registrations", "tezjet_routes"];
const originalEnv = Object.fromEntries(["DATABASE_URL", "TEZJET_STORAGE_ADAPTER", "NODE_ENV", "SESSION_SECRET"].map(key => [key, process.env[key]]));
let moduleDirectory;
let database;
let adminPool;
let store;
let otherStore;
let runtimeStore;
let cancelOrder;
let updateOrderStatus;
let MemoryStore;
let schemaCreated = false;

before(async () => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required: seat-lock regressions must run against real PostgreSQL, never skip or substitute queries.");
  const originalUrl = process.env.DATABASE_URL;
  const isolatedUrl = new URL(originalUrl);
  isolatedUrl.searchParams.set("options", `${isolatedUrl.searchParams.get("options") ?? ""} -c search_path=${schema}`.trim());
  isolatedUrl.searchParams.set("application_name", applicationName);
  process.env.DATABASE_URL = isolatedUrl.href;
  process.env.TEZJET_STORAGE_ADAPTER = "postgres";
  process.env.NODE_ENV = "production";
  process.env.SESSION_SECRET ??= "seat-lock-integration-test-secret-at-least-32-characters";
  moduleDirectory = await mkdtemp(path.join(apiRoot, ".seat-lock-test-"));
  const entry = path.join(moduleDirectory, "production.mjs");
  await build({
    stdin: {
      contents: [
        'export { PostgresStore } from "./src/store/postgresStore";',
        'export { MemoryStore } from "./src/store/memoryStore";',
        'export { pool } from "../../lib/db/src/index";',
        'export { store as runtimeStore } from "./src/store";',
        'export { cancelOrder, updateOrderStatus } from "./src/controllers/orderController";',
      ].join("\n"),
      resolveDir: apiRoot, loader: "ts",
    },
    outfile: entry, bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "silent",
    external: ["pg-native", "pino"],
    banner: { js: 'import { createRequire as testCreateRequire } from "node:module"; const require = testCreateRequire(import.meta.url);' },
  });
  const production = await import(pathToFileURL(entry).href);
  database = production.pool;
  // The real node-postgres constructor exported through the DB package avoids
  // a new dependency and gives the barrier its own physical connections.
  adminPool = new database.constructor({ connectionString: originalUrl, max: 4 });
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  schemaCreated = true;
  for (const table of tables) {
    await adminPool.query(`CREATE TABLE "${schema}"."${table}" (LIKE "public"."${table}" INCLUDING ALL)`);
  }
  store = new production.PostgresStore();
  otherStore = new production.PostgresStore();
  runtimeStore = production.runtimeStore;
  cancelOrder = production.cancelOrder;
  updateOrderStatus = production.updateOrderStatus;
  MemoryStore = production.MemoryStore;
  assert.ok(runtimeStore instanceof production.PostgresStore, "Controller runtime must use the real PostgreSQL adapter.");
  await Promise.all([store.initialize(), otherStore.initialize(), runtimeStore.initialize()]);
}, { timeout: 30_000 });

after(async () => {
  try {
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

const location = { lat: 41.3111, lng: 69.2797, timestamp: 1 };
const stopC = { id: "test-c", code: "C", name: "Test C", sequence: 1, position: 1 };
const stopD = { id: "test-d", code: "D", name: "Test D", sequence: 2, position: 2 };
const fare = {
  currency: "KZT", routeId: "pyatak", pickupStop: stopC, destinationStop: stopD,
  pickupPosition: 1, destinationPosition: 2, distanceStops: 1, pricePerStopKzt: 500,
  minimumFareApplied: false, stops: [stopC, stopD], totalKzt: 500, calculatedAt: new Date(0).toISOString(),
};

async function fixture(t, { seats = [2], expired = true, searching = false, capacity = 8 } = {}) {
  const ownUsers = [];
  const ownOrders = [];
  t.after(async () => {
    // Restrict cleanup to IDs created by this fixture, even inside its private
    // schema. No TRUNCATE or deletion of another test's data is performed.
    await database.query("DELETE FROM tezjet_orders WHERE id = ANY($1::text[])", [ownOrders]);
    await database.query("DELETE FROM tezjet_driver_queue WHERE driver_id = ANY($1::text[])", [ownUsers]);
    await database.query("DELETE FROM tezjet_users WHERE id = ANY($1::text[])", [ownUsers]);
  });
  const createUser = async role => {
    const user = await store.createUser({ role, fullName: "Seat lock regression", phoneNumber: `test-${randomUUID()}`, locale: "ru" });
    ownUsers.push(user.id);
    return user;
  };
  const passenger = await createUser("passenger");
  const driver = await createUser("driver");
  const expiry = expired ? Date.now() - 60_000 : Date.now() + 60 * 60_000;
  const orders = [];
  for (const count of seats) {
    const order = await store.createOrder({
      passengerId: passenger.id, passengerPhone: passenger.phoneNumber,
      pickupPoint: "C", pickupLocation: location, routeStops: [stopC, stopD], fare, destination: "Test D", seats: count,
      status: searching ? "searching" : "en_route_to_c",
      ...(searching ? {} : { driverId: driver.id, offeredDriverId: driver.id, seatLockExpiresAt: expiry }),
    });
    ownOrders.push(order.id);
    orders.push(order);
  }
  const seededEntry = {
    driverId: driver.id, joinedAt: Date.now(), status: searching ? "searching" : "en_route_to_c",
    availableSeats: capacity - (searching ? 0 : seats.reduce((sum, count) => sum + count, 0)),
    lastLocation: location, priorityLock: !searching, inFifo: true,
    activeOrderIds: searching ? [] : orders.map(order => order.id),
    currentOrderId: searching ? undefined : orders[0]?.id,
    seatLockExpiresAt: searching ? undefined : expiry,
  };
  // Joining is a production operation that starts idle. Fixture reservations
  // are seeded explicitly so the join API need not accept stale trip fields.
  await store.joinQueue(seededEntry);
  const entry = await store.updateQueueEntry(driver.id, seededEntry);
  return { passenger, driver, orders, entry, expiry, capacity, createUser };
}

function settlement(promise) {
  return Promise.resolve(promise).then(value => ({ value }), error => ({ error }));
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
  throw new Error(`Expected ${count} actual PostgreSQL transactions waiting on the held row lock.`);
}

/** Waiters enter PostgreSQL in a controlled order, not just Promise.all timing. */
async function overlapping(table, idColumn, id, actions) {
  assert.ok(["tezjet_orders", "tezjet_driver_queue"].includes(table));
  assert.ok(["id", "driver_id"].includes(idColumn));
  const blocker = await adminPool.connect();
  const pending = [];
  try {
    await blocker.query("BEGIN");
    await blocker.query(`SELECT "${idColumn}" FROM "${schema}"."${table}" WHERE "${idColumn}" = $1 FOR UPDATE`, [id]);
    for (const action of actions) {
      pending.push(settlement(Promise.resolve().then(action)));
      await waitForBlockedTransactions(pending.length);
    }
    await blocker.query("COMMIT");
    const results = await Promise.all(pending);
    for (const result of results) if (result.error) throw result.error;
    return results.map(result => result.value);
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
    await Promise.all(pending);
  }
}

async function assertReleased(driverId, orders, capacity) {
  const entry = await store.getQueueEntry(driverId);
  assert.equal(entry.availableSeats, capacity, "Reserved seats must be credited exactly once.");
  assert.equal(entry.status, "searching");
  assert.equal(entry.inFifo, true);
  assert.equal(entry.priorityLock, false);
  assert.deepEqual(entry.activeOrderIds, []);
  assert.equal(entry.currentOrderId, undefined);
  assert.equal(entry.seatLockExpiresAt, undefined);
  for (const order of orders) {
    const current = await store.getOrder(order.id);
    assert.equal(current.status, "searching");
    assert.equal(current.driverId, undefined);
    assert.equal(current.offeredDriverId, undefined);
    assert.equal(current.seatLockExpiresAt, undefined);
  }
}

test("PostgreSQL overlapping expiry cleanup restores a seat reservation exactly once", { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  await overlapping("tezjet_orders", "id", f.orders[0].id, [() => store.clearExpiredSeatLocks(), () => otherStore.clearExpiredSeatLocks()]);
  await assertReleased(f.driver.id, f.orders, f.capacity);
  await store.clearExpiredSeatLocks();
  await assertReleased(f.driver.id, f.orders, f.capacity);
});

test("PostgreSQL overlapping cleanup preserves both expired reservations of one driver", { timeout: 15_000 }, async t => {
  const f = await fixture(t, { seats: [2, 3] });
  await overlapping("tezjet_orders", "id", f.orders[0].id, [() => store.clearExpiredSeatLocks(), () => otherStore.clearExpiredSeatLocks()]);
  await assertReleased(f.driver.id, f.orders, f.capacity);
});

test("PostgreSQL cleanup leaves an unexpired reservation and its queue snapshot unchanged", async t => {
  const f = await fixture(t, { expired: false });
  const beforeOrder = await store.getOrder(f.orders[0].id);
  const beforeQueue = await store.getQueueEntry(f.driver.id);
  await store.clearExpiredSeatLocks();
  assert.deepEqual(await store.getOrder(f.orders[0].id), beforeOrder);
  assert.deepEqual(await store.getQueueEntry(f.driver.id), beforeQueue);
});

test("PostgreSQL queue-only expiry clears the deadline without crediting seats", async t => {
  const f = await fixture(t, { seats: [] });
  await store.updateQueueEntry(f.driver.id, { availableSeats: 3 });
  const beforeQueue = await store.getQueueEntry(f.driver.id);
  await store.clearExpiredSeatLocks();
  assert.deepEqual(await store.getQueueEntry(f.driver.id), { ...beforeQueue, seatLockExpiresAt: undefined });
});

test("PostgreSQL failed order rewrite rolls back the associated seat restoration", async t => {
  const f = await fixture(t);
  const beforeOrder = await store.getOrder(f.orders[0].id);
  const beforeQueue = await store.getQueueEntry(f.driver.id);
  const triggerName = `fail_restore_${randomUUID().replaceAll("-", "")}`;
  await database.query(`CREATE FUNCTION "${schema}"."${triggerName}"() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.id = '${f.orders[0].id}' AND NEW.status = 'searching' THEN RAISE EXCEPTION 'injected seat restoration rollback'; END IF;
      RETURN NEW;
    END $$`);
  await database.query(`CREATE TRIGGER "${triggerName}" BEFORE UPDATE ON "${schema}".tezjet_orders FOR EACH ROW EXECUTE FUNCTION "${schema}"."${triggerName}"()`);
  try {
    await assert.rejects(store.clearExpiredSeatLocks(), error => {
      // Drizzle wraps the PostgreSQL exception in a query error. Require the
      // exact trigger failure, rather than accepting any failed SQL statement.
      assert.equal(error.cause?.code, "P0001");
      assert.match(error.cause?.message ?? "", /injected seat restoration rollback/);
      return true;
    });
    assert.deepEqual(await store.getQueueEntry(f.driver.id), beforeQueue);
    assert.deepEqual(await store.getOrder(f.orders[0].id), beforeOrder);
  } finally {
    await database.query(`DROP TRIGGER "${triggerName}" ON "${schema}".tezjet_orders`);
    await database.query(`DROP FUNCTION "${schema}"."${triggerName}"()`);
  }
  await store.clearExpiredSeatLocks();
  await assertReleased(f.driver.id, f.orders, f.capacity);
});

test("PostgreSQL stale caller snapshots cannot lose seats or active IDs across concurrent claims", { timeout: 15_000 }, async t => {
  const f = await fixture(t, { seats: [2, 2], searching: true, expired: false });
  // Both callers deliberately use the same real pre-claim snapshot. The store
  // must calculate seat deltas and active IDs again under its own row locks.
  const initial = await store.getQueueEntry(f.driver.id);
  const results = await overlapping("tezjet_driver_queue", "driver_id", f.driver.id, f.orders.map(order => () => store.claimOrderForDriver(
    order.id, f.driver.id,
    { status: "en_route_to_c", seatLockExpiresAt: f.expiry },
    { ...initial, status: "en_route_to_c", priorityLock: true, currentOrderId: order.id, activeOrderIds: [order.id], availableSeats: initial.availableSeats - order.seats, seatLockExpiresAt: f.expiry },
  )));
  assert.ok(results.every(Boolean));
  const current = await store.getQueueEntry(f.driver.id);
  assert.equal(current.availableSeats, 4, "Two accepted two-seat orders must debit four seats, even with stale queue patches.");
  assert.deepEqual([...current.activeOrderIds].sort(), f.orders.map(order => order.id).sort());
  for (const order of f.orders) assert.equal((await store.getOrder(order.id)).driverId, f.driver.id);
});

test("PostgreSQL concurrent claims for one order have one winner and never debit the losing driver", { timeout: 15_000 }, async t => {
  const f = await fixture(t, { searching: true, expired: false });
  const secondDriver = await f.createUser("driver");
  await store.joinQueue({ ...f.entry, driverId: secondDriver.id, joinedAt: f.entry.joinedAt + 1 });
  const claim = driver => store.claimOrderForDriver(f.orders[0].id, driver.id,
    { status: "en_route_to_c", seatLockExpiresAt: f.expiry },
    { ...f.entry, availableSeats: 6, activeOrderIds: [f.orders[0].id], currentOrderId: f.orders[0].id, status: "en_route_to_c", seatLockExpiresAt: f.expiry },
  );
  const results = await overlapping("tezjet_orders", "id", f.orders[0].id, [() => claim(f.driver), () => claim(secondDriver)]);
  assert.ok(results[0]);
  assert.equal(results[1], undefined);
  assert.equal((await store.getOrder(f.orders[0].id)).driverId, f.driver.id);
  assert.equal((await store.getQueueEntry(f.driver.id)).availableSeats, 6);
  assert.equal((await store.getQueueEntry(secondDriver.id)).availableSeats, 8);
});

test("PostgreSQL an old offered-driver patch cannot resurrect an order after expiry cleanup", { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  const nextDriver = await f.createUser("driver");
  await overlapping("tezjet_orders", "id", f.orders[0].id, [
    () => store.clearExpiredSeatLocks(),
    () => otherStore.updateOrder(f.orders[0].id, { offeredDriverId: nextDriver.id }),
  ]);
  const current = await store.getOrder(f.orders[0].id);
  assert.equal(current.status, "searching", "An offered-driver-only patch must preserve the freshly reopened state.");
  assert.equal(current.driverId, undefined);
  assert.equal(current.seatLockExpiresAt, undefined);
  assert.equal(current.offeredDriverId, nextDriver.id);
  assert.equal((await store.getQueueEntry(f.driver.id)).availableSeats, 8);
});

async function pausedControllerSnapshot(t, f, invoke) {
  const originalGetOrder = runtimeStore.getOrder;
  let signalRead;
  let resumeRead;
  const read = new Promise(resolve => { signalRead = resolve; });
  const resume = new Promise(resolve => { resumeRead = resolve; });
  let paused = false;
  runtimeStore.getOrder = async function (id) {
    const actual = await originalGetOrder.call(this, id);
    if (id === f.orders[0].id && !paused) {
      paused = true;
      signalRead();
      await resume;
    }
    return actual;
  };
  const pending = settlement(Promise.resolve().then(invoke));
  try {
    await Promise.race([read, new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error("Controller never read the real order snapshot")), 5_000);
      timer.unref();
    })]);
    await store.clearExpiredSeatLocks();
    resumeRead();
    return await pending;
  } finally {
    resumeRead();
    runtimeStore.getOrder = originalGetOrder;
    await pending;
  }
}

function controllerRequest(f, role = "passenger", body = {}) {
  const user = role === "passenger" ? f.passenger : f.driver;
  return { params: { orderId: f.orders[0].id }, body, auth: { userId: user.id, role, locale: "ru", user }, app: { locals: {} } };
}

test("PostgreSQL real cancellation controller rejects a stale snapshot after cleanup without double-crediting seats", { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  const outcome = await pausedControllerSnapshot(t, f, () => cancelOrder(controllerRequest(f), { json() {} }));
  assert.equal((await store.getQueueEntry(f.driver.id)).availableSeats, 8, "Stale cancellation must not credit already restored seats again.");
  assert.equal(outcome.error?.statusCode, 409);
  await assertReleased(f.driver.id, f.orders, f.capacity);
});

test("PostgreSQL real status controller rejects a stale arrival snapshot after cleanup", { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  const outcome = await pausedControllerSnapshot(t, f, () => updateOrderStatus(controllerRequest(f, "driver", { status: "arrived_at_c" }), { json() {} }));
  assert.equal(outcome.error?.statusCode, 409);
  await assertReleased(f.driver.id, f.orders, f.capacity);
});

test("PostgreSQL cancellation winning the lock race preserves cancellation and restores seats once", { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  const results = await overlapping("tezjet_orders", "id", f.orders[0].id, [
    () => store.transitionOrder(f.orders[0].id, f.passenger.id, "cancelled", "en_route_to_c"),
    () => otherStore.clearExpiredSeatLocks(),
  ]);
  assert.equal(results[0]?.status, "cancelled");
  assert.equal((await store.getOrder(f.orders[0].id)).status, "cancelled");
  assert.equal((await store.getQueueEntry(f.driver.id)).availableSeats, 8);
  await store.clearExpiredSeatLocks();
  assert.equal((await store.getQueueEntry(f.driver.id)).availableSeats, 8);
});

test("PostgreSQL cleanup winning the lock race makes stale cancellation conflict", { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  const results = await overlapping("tezjet_orders", "id", f.orders[0].id, [
    () => store.clearExpiredSeatLocks(),
    () => otherStore.transitionOrder(f.orders[0].id, f.passenger.id, "cancelled", "en_route_to_c"),
  ]);
  assert.equal(results[1], undefined);
  await assertReleased(f.driver.id, f.orders, f.capacity);
});

test("PostgreSQL arrival winning the lock race keeps seats reserved and prevents cleanup reopening", { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  await overlapping("tezjet_orders", "id", f.orders[0].id, [
    () => store.transitionOrder(f.orders[0].id, f.driver.id, "arrived_at_c", "en_route_to_c"),
    () => otherStore.clearExpiredSeatLocks(),
  ]);
  assert.equal((await store.getOrder(f.orders[0].id)).status, "arrived_at_c");
  const current = await store.getQueueEntry(f.driver.id);
  assert.equal(current.availableSeats, 6);
  assert.deepEqual(current.activeOrderIds, [f.orders[0].id]);
  assert.equal(current.currentOrderId, f.orders[0].id);
});

test("PostgreSQL cleanup winning the lock race makes stale arrival conflict", { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  const results = await overlapping("tezjet_orders", "id", f.orders[0].id, [
    () => store.clearExpiredSeatLocks(),
    () => otherStore.transitionOrder(f.orders[0].id, f.driver.id, "arrived_at_c", "en_route_to_c"),
  ]);
  assert.equal(results[1], undefined);
  await assertReleased(f.driver.id, f.orders, f.capacity);
});

test("PostgreSQL concurrent cancellation of two orders preserves both seat credits", { timeout: 15_000 }, async t => {
  const f = await fixture(t, { seats: [2, 3], expired: false });
  const results = await overlapping("tezjet_driver_queue", "driver_id", f.driver.id,
    f.orders.map(order => () => store.transitionOrder(order.id, f.passenger.id, "cancelled", "en_route_to_c")));
  assert.ok(results.every(order => order?.status === "cancelled"));
  const current = await store.getQueueEntry(f.driver.id);
  assert.equal(current.availableSeats, 8);
  assert.deepEqual(current.activeOrderIds, []);
  assert.equal(current.status, "searching");
  assert.equal(current.currentOrderId, undefined);
});

test("PostgreSQL lifecycle checks the live actor and completion restores seats only once", async t => {
  const f = await fixture(t, { expired: false });
  const outsider = await f.createUser("passenger");
  const orderId = f.orders[0].id;
  assert.equal(await store.transitionOrder(orderId, outsider.id, "cancelled"), undefined);
  assert.equal(await store.transitionOrder(orderId, f.passenger.id, "arrived_at_c"), undefined);
  assert.equal((await store.getQueueEntry(f.driver.id)).availableSeats, 6);
  assert.equal((await store.transitionOrder(orderId, f.driver.id, "arrived_at_c", "en_route_to_c"))?.status, "arrived_at_c");
  assert.equal((await store.transitionOrder(orderId, f.driver.id, "in_transit", "arrived_at_c"))?.status, "in_transit");
  assert.equal((await store.transitionOrder(orderId, f.driver.id, "completed", "in_transit"))?.status, "completed");
  assert.equal(await store.transitionOrder(orderId, f.driver.id, "completed"), undefined);
  assert.equal(await store.transitionOrder(orderId, f.passenger.id, "cancelled"), undefined);
  const current = await store.getQueueEntry(f.driver.id);
  assert.equal(current.availableSeats, 8);
  assert.deepEqual(current.activeOrderIds, []);
  assert.equal(current.currentOrderId, undefined);
  assert.equal((await store.getOrder(orderId)).driverId, f.driver.id, "Completed trips retain the assigned driver for history.");
});

test("PostgreSQL rejoining cannot reset occupied seats or active order identifiers", async t => {
  const f = await fixture(t, { expired: false });
  const beforeQueue = await store.getQueueEntry(f.driver.id);
  await assert.rejects(store.joinQueue({
    ...beforeQueue, availableSeats: 8, status: "searching", activeOrderIds: [], currentOrderId: undefined,
  }), { statusCode: 409, code: "QUEUE_BUSY" });
  assert.deepEqual(await store.getQueueEntry(f.driver.id), beforeQueue);
  assert.equal((await store.getOrder(f.orders[0].id)).driverId, f.driver.id);
});

test("PostgreSQL leaving cannot delete an active reservation even without currentOrderId", async t => {
  const f = await fixture(t, { expired: false });
  await store.updateQueueEntry(f.driver.id, { currentOrderId: undefined });
  const beforeQueue = await store.getQueueEntry(f.driver.id);
  await assert.rejects(store.leaveQueue(f.driver.id), { statusCode: 409, code: "ACTIVE_ORDER" });
  assert.deepEqual(await store.getQueueEntry(f.driver.id), beforeQueue);
});

test("PostgreSQL rejoining after expiry ignores stale reservation fields and preserves FIFO time", async t => {
  const f = await fixture(t);
  const oldQueue = await store.getQueueEntry(f.driver.id);
  await store.clearExpiredSeatLocks();
  const current = await store.getQueueEntry(f.driver.id);
  const joined = await store.joinQueue({ ...oldQueue, availableSeats: 8, joinedAt: oldQueue.joinedAt - 10_000 });
  assert.deepEqual(joined, current);
  await assertReleased(f.driver.id, f.orders, f.capacity);
});

test("PostgreSQL simultaneous idle rejoins preserve the existing FIFO position", { timeout: 15_000 }, async t => {
  const f = await fixture(t, { searching: true, seats: [], expired: false });
  const results = await overlapping("tezjet_driver_queue", "driver_id", f.driver.id, [
    () => store.joinQueue({ ...f.entry, joinedAt: 1, availableSeats: 5 }),
    () => otherStore.joinQueue({ ...f.entry, joinedAt: 2, availableSeats: 7 }),
  ]);
  assert.deepEqual(results.map(entry => entry.availableSeats), [5, 7]);
  const current = await store.getQueueEntry(f.driver.id);
  assert.equal(current.joinedAt, f.entry.joinedAt);
  assert.equal(current.availableSeats, 7);
  assert.equal(current.currentOrderId, undefined);
  assert.deepEqual(current.activeOrderIds, []);
});

function claimFixture(f) {
  return store.claimOrderForDriver(f.orders[0].id, f.driver.id,
    { status: "en_route_to_c", seatLockExpiresAt: f.expiry }, {});
}

test("PostgreSQL a claim winning against leave keeps its queue and seat debit", { timeout: 15_000 }, async t => {
  const f = await fixture(t, { searching: true, expired: false });
  const results = await overlapping("tezjet_driver_queue", "driver_id", f.driver.id, [
    () => claimFixture(f),
    () => otherStore.leaveQueue(f.driver.id).catch(error => ({ error })),
  ]);
  assert.equal(results[0]?.driverId, f.driver.id);
  assert.equal(results[1]?.error?.statusCode, 409);
  const current = await store.getQueueEntry(f.driver.id);
  assert.equal(current.availableSeats, 6);
  assert.deepEqual(current.activeOrderIds, [f.orders[0].id]);
});

test("PostgreSQL leave winning against a claim keeps the order unassigned", { timeout: 15_000 }, async t => {
  const f = await fixture(t, { searching: true, expired: false });
  const results = await overlapping("tezjet_driver_queue", "driver_id", f.driver.id, [
    () => store.leaveQueue(f.driver.id),
    () => claimFixture(f),
  ]);
  assert.equal(results[1], undefined);
  assert.equal(await store.getQueueEntry(f.driver.id), undefined);
  const order = await store.getOrder(f.orders[0].id);
  assert.equal(order.status, "searching");
  assert.equal(order.driverId, undefined);
  await store.leaveQueue(f.driver.id); // An already absent entry is harmless.
});

test("PostgreSQL a claim winning against stale rejoin preserves its reservation", { timeout: 15_000 }, async t => {
  const f = await fixture(t, { searching: true, expired: false });
  const results = await overlapping("tezjet_driver_queue", "driver_id", f.driver.id, [
    () => claimFixture(f),
    () => otherStore.joinQueue(f.entry).catch(error => ({ error })),
  ]);
  assert.ok(results[0]);
  assert.equal(results[1]?.error?.statusCode, 409);
  const current = await store.getQueueEntry(f.driver.id);
  assert.equal(current.availableSeats, 6);
  assert.deepEqual(current.activeOrderIds, [f.orders[0].id]);
});

test("PostgreSQL rejoin winning against a claim rechecks the reduced seat count", { timeout: 15_000 }, async t => {
  const f = await fixture(t, { searching: true, expired: false });
  const results = await overlapping("tezjet_driver_queue", "driver_id", f.driver.id, [
    () => store.joinQueue({ ...f.entry, availableSeats: 1 }),
    () => claimFixture(f),
  ]);
  assert.equal(results[0].availableSeats, 1);
  assert.equal(results[1], undefined);
  assert.equal((await store.getQueueEntry(f.driver.id)).availableSeats, 1);
  assert.equal((await store.getOrder(f.orders[0].id)).status, "searching");
});

test("PostgreSQL a fresh join cannot restore trip fields from a deleted queue snapshot", async t => {
  const f = await fixture(t, { searching: true, seats: [], expired: false });
  await store.leaveQueue(f.driver.id);
  const beforeJoin = Date.now();
  const joined = await store.joinQueue({
    ...f.entry, joinedAt: 1, status: "in_transit", inFifo: false, priorityLock: true,
    activeOrderIds: ["old-order"], currentOrderId: "old-order", seatLockExpiresAt: f.expiry,
  });
  assert.ok(joined.joinedAt >= beforeJoin);
  assert.equal(joined.status, "searching");
  assert.equal(joined.inFifo, true);
  assert.equal(joined.priorityLock, false);
  assert.deepEqual(joined.activeOrderIds, []);
  assert.equal(joined.currentOrderId, undefined);
  assert.equal(joined.seatLockExpiresAt, undefined);
});

test("MemoryStore enforces the same queue join and leave ownership boundaries", () => {
  const memory = new MemoryStore();
  const driver = memory.createUser({ role: "driver", fullName: "Memory queue driver", phoneNumber: "memory-queue-driver", locale: "ru" });
  const input = {
    driverId: driver.id, joinedAt: 1, availableSeats: 8, lastLocation: location,
    status: "in_transit", priorityLock: true, inFifo: false,
    activeOrderIds: ["old-order"], currentOrderId: "old-order", seatLockExpiresAt: Date.now() + 60_000,
  };
  const joined = memory.joinQueue(input);
  assert.equal(joined.status, "searching");
  assert.deepEqual(joined.activeOrderIds, []);
  assert.equal(joined.currentOrderId, undefined);
  assert.equal(joined.inFifo, true);
  const updated = memory.joinQueue({ ...input, availableSeats: 7 });
  assert.equal(updated.joinedAt, joined.joinedAt);
  assert.equal(updated.availableSeats, 7);
  memory.updateQueueEntry(input.driverId, { activeOrderIds: ["accepted-order"], currentOrderId: undefined, availableSeats: 5 });
  assert.throws(() => memory.joinQueue(input), { statusCode: 409, code: "QUEUE_BUSY" });
  assert.throws(() => memory.leaveQueue(input.driverId), { statusCode: 409, code: "ACTIVE_ORDER" });
  assert.equal(memory.getQueueEntry(input.driverId).availableSeats, 5);
  memory.updateQueueEntry(input.driverId, { activeOrderIds: [] });
  memory.leaveQueue(input.driverId);
  assert.equal(memory.getQueueEntry(input.driverId), undefined);
});
