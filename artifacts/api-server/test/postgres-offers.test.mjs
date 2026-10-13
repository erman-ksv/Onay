import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// Production adapters, real PostgreSQL transactions, and a private schema.
// Store methods accept an explicit clock: advancing it verifies the normal
// 60-second deadline without shortening production settings or sleeping.
const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schema = `offers_test_${randomUUID().replaceAll("-", "")}`;
const applicationName = `offers-${randomUUID()}`;
const tables = ["tezjet_users", "tezjet_otp_challenges", "tezjet_driver_queue", "tezjet_orders", "tezjet_device_registrations", "tezjet_routes"];
const envKeys = ["DATABASE_URL", "TEZJET_STORAGE_ADAPTER", "NODE_ENV", "SESSION_SECRET", "TEZJET_OFFER_TIMEOUT_SECONDS"];
const originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
let moduleDirectory;
let database;
let adminPool;
let store;
let otherStore;
let PostgresStore;
let MemoryStore;
let schemaCreated = false;

before(async () => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required: offer regressions must execute against real PostgreSQL.");
  const originalUrl = process.env.DATABASE_URL;
  const isolatedUrl = new URL(originalUrl);
  isolatedUrl.searchParams.set("options", `${isolatedUrl.searchParams.get("options") ?? ""} -c search_path=${schema}`.trim());
  isolatedUrl.searchParams.set("application_name", applicationName);
  process.env.DATABASE_URL = isolatedUrl.href;
  process.env.TEZJET_STORAGE_ADAPTER = "postgres";
  process.env.NODE_ENV = "production";
  process.env.SESSION_SECRET ??= "offer-regression-test-secret-at-least-32-characters";
  delete process.env.TEZJET_OFFER_TIMEOUT_SECONDS;
  moduleDirectory = await mkdtemp(path.join(apiRoot, ".offers-test-"));
  const entry = path.join(moduleDirectory, "production.mjs");
  await build({
    stdin: {
      contents: [
        'export { PostgresStore } from "./src/store/postgresStore";',
        'export { MemoryStore } from "./src/store/memoryStore";',
        'export { pool } from "../../lib/db/src/index";',
      ].join("\n"),
      resolveDir: apiRoot, loader: "ts",
    },
    outfile: entry, bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "silent",
    external: ["pg-native", "pino"],
    banner: { js: 'import { createRequire as testCreateRequire } from "node:module"; const require = testCreateRequire(import.meta.url);' },
  });
  const production = await import(pathToFileURL(entry).href);
  database = production.pool;
  adminPool = new database.constructor({ connectionString: originalUrl, max: 4 });
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  schemaCreated = true;
  for (const table of tables) {
    await adminPool.query(`CREATE TABLE "${schema}"."${table}" (LIKE "public"."${table}" INCLUDING ALL)`);
  }
  PostgresStore = production.PostgresStore;
  MemoryStore = production.MemoryStore;
  store = new PostgresStore();
  otherStore = new PostgresStore();
  await Promise.all([store.initialize(), otherStore.initialize()]);
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
const stopC = { id: "offer-c", code: "C", name: "Offer C", sequence: 1, position: 1 };
const stopD = { id: "offer-d", code: "D", name: "Offer D", sequence: 2, position: 2 };
const fare = {
  currency: "KZT", routeId: "pyatak", pickupStop: stopC, destinationStop: stopD,
  pickupPosition: 1, destinationPosition: 2, distanceStops: 1, pricePerStopKzt: 500,
  minimumFareApplied: false, stops: [stopC, stopD], totalKzt: 500, calculatedAt: new Date(0).toISOString(),
};

async function fixture(t, { adapter = store, driverSeats = [4, 4], seats = 2, pickupPoint = "C", orderCount = 1 } = {}) {
  const userIds = [];
  const orderIds = [];
  if (adapter instanceof PostgresStore) t.after(async () => {
    await database.query("DELETE FROM tezjet_orders WHERE id = ANY($1::text[])", [orderIds]);
    await database.query("DELETE FROM tezjet_driver_queue WHERE driver_id = ANY($1::text[])", [userIds]);
    await database.query("DELETE FROM tezjet_users WHERE id = ANY($1::text[])", [userIds]);
  });
  const createUser = async role => {
    const user = await adapter.createUser({ role, fullName: "Offer regression", phoneNumber: `offers-${randomUUID()}`, locale: "ru" });
    userIds.push(user.id);
    if (role === "driver") await adapter.setDriverApproval(user.id, "approved");
    return user;
  };
  const passenger = await createUser("passenger");
  const drivers = [];
  for (const capacity of driverSeats) {
    const driver = await createUser("driver");
    drivers.push(driver);
    await adapter.joinQueue({
      driverId: driver.id, joinedAt: drivers.length, status: "searching", availableSeats: capacity,
      lastLocation: location, priorityLock: false, inFifo: true, activeOrderIds: [],
    });
    // Joining owns its timestamp. Set a deterministic FIFO fixture before any
    // offer exists, so simultaneous joins and UUID ordering cannot affect it.
    await adapter.updateQueueEntry(driver.id, { joinedAt: drivers.length });
  }
  const orderInput = (patch = {}) => ({
      passengerId: passenger.id, passengerPhone: passenger.phoneNumber,
      pickupPoint, pickupLocation: location, routeStops: [stopC, stopD], fare, destination: "Offer D", seats,
      status: "searching", attemptedDriverIds: [], ...patch,
  });
  const createOrder = async (patch = {}) => {
    const order = await adapter.createOrder(orderInput(patch));
    orderIds.push(order.id);
    return order;
  };
  const createOrderWithOffer = async (patch = {}, creator = adapter) => {
    const order = await creator.createOrderWithOffer(orderInput(patch));
    if (order) orderIds.push(order.id);
    return order;
  };
  const orders = [];
  for (let i = 0; i < orderCount; i++) orders.push(await createOrder());
  return { adapter, passenger, drivers, orders, driverSeats, createUser, createOrder, createOrderWithOffer, now: Date.now() + 3_600_000 };
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
  throw new Error(`Expected ${count} production PostgreSQL transactions blocked on the held row lock.`);
}

// Physical PostgreSQL row locks establish an overlap and waiter order. A plain
// Promise.all could silently run sequentially and miss reservation races.
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

async function assertPending(f, driverIndex, order, capacity = f.driverSeats[driverIndex]) {
  const entry = await f.adapter.getQueueEntry(f.drivers[driverIndex].id);
  assert.equal(entry.pendingOfferOrderId, order.id);
  assert.equal(entry.availableSeats, capacity - order.seats, "Offering must reserve seats immediately.");
  assert.ok(!entry.activeOrderIds.includes(order.id), "A pending offer is not an accepted trip.");
  const current = await f.adapter.getOrder(order.id);
  assert.equal(current.status, "searching");
  assert.equal(current.driverId, undefined);
  assert.equal(current.offeredDriverId, entry.driverId);
  return entry;
}

async function assertIdle(f, driverIndex, capacity = f.driverSeats[driverIndex]) {
  const entry = await f.adapter.getQueueEntry(f.drivers[driverIndex].id);
  assert.equal(entry.pendingOfferOrderId, undefined);
  assert.equal(entry.availableSeats, capacity, "Seats must return exactly once.");
  assert.deepEqual(entry.activeOrderIds, []);
  assert.equal(entry.currentOrderId, undefined);
}

test("PostgreSQL a FIFO offer reserves seats for 60 seconds and acceptance consumes the same reservation", async t => {
  const f = await fixture(t);
  const offered = await store.dispatchOrderOffer(f.orders[0].id, f.now);
  assert.equal(offered.order.offerExpiresAt, f.now + 60_000);
  assert.deepEqual(offered.order.attemptedDriverIds, [f.drivers[0].id]);
  await assertPending(f, 0, offered.order);
  const accepted = await otherStore.acceptOrderOffer(offered.order.id, f.drivers[0].id, f.now + 1);
  assert.equal(accepted.status, "en_route_to_c");
  assert.equal(accepted.driverId, f.drivers[0].id);
  assert.equal(accepted.offerExpiresAt, undefined);
  const entry = await store.getQueueEntry(f.drivers[0].id);
  assert.equal(entry.availableSeats, 2, "Acceptance must not debit reserved seats a second time.");
  assert.equal(entry.pendingOfferOrderId, undefined);
  assert.deepEqual(entry.activeOrderIds, [accepted.id]);
  assert.equal(await store.acceptOrderOffer(accepted.id, f.drivers[0].id, f.now + 2), undefined);
  assert.equal((await store.getQueueEntry(f.drivers[0].id)).availableSeats, 2);
});

test("PostgreSQL availability and atomic creation reject insufficient or inactive drivers without persisting an order", async t => {
  const f = await fixture(t, { driverSeats: [1], orderCount: 0 });
  assert.deepEqual(await store.getOrderAvailability("C", 2), { available: false, eligibleDriverCount: 0 });
  assert.deepEqual(await store.getOrderAvailability("D", 1), { available: false, eligibleDriverCount: 0 });
  assert.equal(await f.createOrderWithOffer(), undefined);
  assert.deepEqual(await store.listOrdersForUser(f.passenger.id), []);
  await assertIdle(f, 0);
});

test("PostgreSQL overlapping atomic creations produce one order and one reservation for one available driver", { timeout: 15_000 }, async t => {
  const f = await fixture(t, { driverSeats: [4], orderCount: 0 });
  assert.deepEqual(await store.getOrderAvailability("C", 2), { available: true, eligibleDriverCount: 1 });
  const results = await overlapping("tezjet_driver_queue", "driver_id", f.drivers[0].id, [
    () => f.createOrderWithOffer({}, otherStore),
    () => f.createOrderWithOffer(),
  ]);
  assert.equal(results.filter(Boolean).length, 1);
  const order = results.find(Boolean);
  const ownedOrders = await store.listOrdersForUser(f.passenger.id);
  assert.deepEqual(ownedOrders.map(candidate => candidate.id), [order.id], "The losing creation cannot leave a waiting order behind.");
  await assertPending(f, 0, order);
  assert.deepEqual(await store.getOrderAvailability("C", 1), { available: false, eligibleDriverCount: 0 });
});

test("PostgreSQL rejection advances FIFO, preserves attempts, and never reoffers to an attempted driver", async t => {
  const f = await fixture(t);
  const first = await store.dispatchOrderOffer(f.orders[0].id, f.now);
  const second = await otherStore.rejectOrderOffer(first.order.id, f.drivers[0].id, f.now + 1);
  assert.equal(second.previousDriverId, f.drivers[0].id);
  assert.equal(second.order.offeredDriverId, f.drivers[1].id);
  assert.equal(second.order.offerExpiresAt, f.now + 60_001);
  assert.deepEqual(second.order.attemptedDriverIds, f.drivers.map(driver => driver.id));
  await assertIdle(f, 0);
  await assertPending(f, 1, second.order);
  const exhausted = await store.rejectOrderOffer(first.order.id, f.drivers[1].id, f.now + 2);
  assert.equal(exhausted.previousDriverId, f.drivers[1].id);
  assert.equal(exhausted.order.offeredDriverId, undefined);
  assert.equal(exhausted.order.offerExpiresAt, undefined);
  await assertIdle(f, 1);
  assert.equal(await store.dispatchOrderOffer(first.order.id, f.now + 3), undefined);
  assert.deepEqual(await store.processOrderOffers(f.now + 4), []);
  assert.deepEqual((await store.getOrder(first.order.id)).attemptedDriverIds, f.drivers.map(driver => driver.id));
});

test("PostgreSQL dispatch skips insufficient seats and a driver with another pending offer", async t => {
  const f = await fixture(t, { driverSeats: [1, 4, 4], orderCount: 2 });
  const first = await store.dispatchOrderOffer(f.orders[0].id, f.now);
  assert.equal(first.order.offeredDriverId, f.drivers[1].id);
  const second = await otherStore.dispatchOrderOffer(f.orders[1].id, f.now);
  assert.equal(second.order.offeredDriverId, f.drivers[2].id);
  await assertIdle(f, 0);
  await assertPending(f, 1, first.order);
  await assertPending(f, 2, second.order);
  assert.deepEqual(first.order.attemptedDriverIds, [f.drivers[1].id], "Ineligible drivers do not consume an attempt.");
});

test("PostgreSQL wrong-driver, stale, and deadline-expired actions cannot mutate an offer", async t => {
  const f = await fixture(t);
  const first = await store.dispatchOrderOffer(f.orders[0].id, f.now);
  const beforeOrder = await store.getOrder(first.order.id);
  const beforeQueue = await store.getQueueEntry(f.drivers[0].id);
  assert.equal(await otherStore.acceptOrderOffer(first.order.id, f.drivers[1].id, f.now), undefined);
  assert.equal(await otherStore.rejectOrderOffer(first.order.id, f.drivers[1].id, f.now), undefined);
  assert.equal(await store.acceptOrderOffer(first.order.id, f.drivers[0].id, first.order.offerExpiresAt), undefined);
  assert.deepEqual(await store.getOrder(first.order.id), beforeOrder);
  assert.deepEqual(await store.getQueueEntry(f.drivers[0].id), beforeQueue);
  const [expired] = await otherStore.processOrderOffers(first.order.offerExpiresAt);
  assert.equal(expired.previousDriverId, f.drivers[0].id);
  assert.equal(expired.order.offeredDriverId, f.drivers[1].id);
  const nextOrder = await store.getOrder(first.order.id);
  const nextQueue = await store.getQueueEntry(f.drivers[1].id);
  assert.equal(await store.acceptOrderOffer(first.order.id, f.drivers[0].id, f.now + 60_001), undefined);
  assert.equal(await store.rejectOrderOffer(first.order.id, f.drivers[0].id, f.now + 60_001), undefined);
  assert.deepEqual(await store.getOrder(first.order.id), nextOrder);
  assert.deepEqual(await store.getQueueEntry(f.drivers[1].id), nextQueue);
  await assertIdle(f, 0);
});

test("PostgreSQL processing preserves a live offer and advances exactly at its deadline", async t => {
  const f = await fixture(t);
  const first = await store.dispatchOrderOffer(f.orders[0].id, f.now);
  const beforeOrder = await store.getOrder(first.order.id);
  const beforeQueue = await store.getQueueEntry(f.drivers[0].id);
  assert.deepEqual(await store.processOrderOffers(f.now + 59_999), []);
  assert.deepEqual(await store.getOrder(first.order.id), beforeOrder);
  assert.deepEqual(await store.getQueueEntry(f.drivers[0].id), beforeQueue);
  const [next] = await otherStore.processOrderOffers(f.now + 60_000);
  assert.equal(next.order.offeredDriverId, f.drivers[1].id);
  await assertIdle(f, 0);
  await assertPending(f, 1, next.order);
});

test("PostgreSQL waiting orders are dispatched in creation order when a driver becomes available", async t => {
  const f = await fixture(t, { driverSeats: [4], orderCount: 2 });
  await store.leaveQueue(f.drivers[0].id);
  // Distinct timestamps make the backlog ordering assertion independent of
  // millisecond clock resolution and the IDs generated by the fixture.
  await database.query("UPDATE tezjet_orders SET created_at = $1 WHERE id = $2", [new Date(1).toISOString(), f.orders[0].id]);
  await database.query("UPDATE tezjet_orders SET created_at = $1 WHERE id = $2", [new Date(2).toISOString(), f.orders[1].id]);
  assert.equal(await store.dispatchOrderOffer(f.orders[0].id, f.now), undefined);
  await store.joinQueue({ driverId: f.drivers[0].id, joinedAt: 1, status: "searching", availableSeats: 4, lastLocation: location, priorityLock: false, inFifo: true, activeOrderIds: [] });
  const changes = await otherStore.processOrderOffers(f.now);
  assert.deepEqual(changes.map(change => change.order.id), [f.orders[0].id]);
  await assertPending(f, 0, changes[0].order);
  assert.equal((await store.getOrder(f.orders[1].id)).offeredDriverId, undefined);
});

test("PostgreSQL overlapping dispatches of one order reserve seats only once", { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  const results = await overlapping("tezjet_orders", "id", f.orders[0].id, [
    () => store.dispatchOrderOffer(f.orders[0].id, f.now),
    () => otherStore.dispatchOrderOffer(f.orders[0].id, f.now),
  ]);
  assert.equal(results.filter(Boolean).length, 1);
  await assertPending(f, 0, results.find(Boolean).order);
  await assertIdle(f, 1);
});

test("PostgreSQL overlapping dispatches of different orders cannot offer the same driver twice", { timeout: 15_000 }, async t => {
  const f = await fixture(t, { driverSeats: [6], orderCount: 2 });
  const results = await overlapping("tezjet_driver_queue", "driver_id", f.drivers[0].id, [
    () => store.dispatchOrderOffer(f.orders[0].id, f.now),
    () => otherStore.dispatchOrderOffer(f.orders[1].id, f.now),
  ]);
  assert.equal(results.filter(Boolean).length, 1);
  const winner = results.find(Boolean).order;
  await assertPending(f, 0, winner);
  const loser = f.orders.find(order => order.id !== winner.id);
  assert.equal((await store.getOrder(loser.id)).offeredDriverId, undefined);
  await store.transitionOrder(winner.id, f.passenger.id, "cancelled", "searching");
  const [next] = await otherStore.processOrderOffers(f.now + 1);
  assert.equal(next.order.id, loser.id);
  await assertPending(f, 0, next.order);
});

test("PostgreSQL acceptance winning against rejection retains one accepted reservation", { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  const first = await store.dispatchOrderOffer(f.orders[0].id, f.now);
  const [accepted, rejected] = await overlapping("tezjet_orders", "id", first.order.id, [
    () => store.acceptOrderOffer(first.order.id, f.drivers[0].id, f.now + 1),
    () => otherStore.rejectOrderOffer(first.order.id, f.drivers[0].id, f.now + 1),
  ]);
  assert.equal(accepted.driverId, f.drivers[0].id);
  assert.equal(rejected, undefined);
  assert.equal((await store.getQueueEntry(f.drivers[0].id)).availableSeats, 2);
  assert.deepEqual((await store.getQueueEntry(f.drivers[0].id)).activeOrderIds, [first.order.id]);
  await assertIdle(f, 1);
});

test("PostgreSQL rejection winning against acceptance advances without a stale debit", { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  const first = await store.dispatchOrderOffer(f.orders[0].id, f.now);
  const [rejected, accepted] = await overlapping("tezjet_orders", "id", first.order.id, [
    () => store.rejectOrderOffer(first.order.id, f.drivers[0].id, f.now + 1),
    () => otherStore.acceptOrderOffer(first.order.id, f.drivers[0].id, f.now + 1),
  ]);
  assert.equal(rejected.order.offeredDriverId, f.drivers[1].id);
  assert.equal(accepted, undefined);
  await assertIdle(f, 0);
  await assertPending(f, 1, rejected.order);
});

test("PostgreSQL acceptance winning against expiry keeps the accepted trip", { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  const first = await store.dispatchOrderOffer(f.orders[0].id, f.now);
  const [accepted, changes] = await overlapping("tezjet_orders", "id", first.order.id, [
    () => store.acceptOrderOffer(first.order.id, f.drivers[0].id, f.now + 59_999),
    () => otherStore.processOrderOffers(f.now + 60_000),
  ]);
  assert.equal(accepted.driverId, f.drivers[0].id);
  assert.deepEqual(changes, []);
  assert.equal((await store.getQueueEntry(f.drivers[0].id)).availableSeats, 2);
  assert.equal((await store.getOrder(first.order.id)).status, "en_route_to_c");
  await assertIdle(f, 1);
});

test("PostgreSQL expiry winning against an old acceptance rejects the old recipient", { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  const first = await store.dispatchOrderOffer(f.orders[0].id, f.now);
  const [changes, accepted] = await overlapping("tezjet_orders", "id", first.order.id, [
    () => store.processOrderOffers(f.now + 60_000),
    () => otherStore.acceptOrderOffer(first.order.id, f.drivers[0].id, f.now + 59_999),
  ]);
  assert.equal(changes[0].order.offeredDriverId, f.drivers[1].id);
  assert.equal(accepted, undefined);
  await assertIdle(f, 0);
  await assertPending(f, 1, changes[0].order);
});

test("PostgreSQL overlapping expiry workers advance an offer and restore its seats exactly once", { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  const first = await store.dispatchOrderOffer(f.orders[0].id, f.now);
  const results = await overlapping("tezjet_orders", "id", first.order.id, [
    () => store.processOrderOffers(f.now + 60_000),
    () => otherStore.processOrderOffers(f.now + 60_000),
  ]);
  const changes = results.flat();
  assert.equal(changes.length, 1);
  assert.equal(changes[0].previousDriverId, f.drivers[0].id);
  await assertIdle(f, 0);
  await assertPending(f, 1, changes[0].order);
  assert.deepEqual(await store.processOrderOffers(f.now + 60_000), []);
  const [exhausted] = await otherStore.processOrderOffers(f.now + 120_000);
  assert.equal(exhausted.order.offeredDriverId, undefined);
  await assertIdle(f, 0);
  await assertIdle(f, 1);
  assert.deepEqual(await store.processOrderOffers(f.now + 120_001), []);
});

test("PostgreSQL cancellation of a pending offer returns seats and expiry cannot reopen it", { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  const first = await store.dispatchOrderOffer(f.orders[0].id, f.now);
  const [cancelled, changes] = await overlapping("tezjet_orders", "id", first.order.id, [
    () => store.transitionOrder(first.order.id, f.passenger.id, "cancelled", "searching"),
    () => otherStore.processOrderOffers(f.now + 60_000),
  ]);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.offeredDriverId, f.drivers[0].id, "Cancellation retains the committed recipient for withdrawal delivery.");
  assert.equal(cancelled.offerExpiresAt, undefined);
  assert.deepEqual(changes, []);
  await assertIdle(f, 0);
  await assertIdle(f, 1);
  assert.equal(await store.rejectOrderOffer(first.order.id, f.drivers[0].id, f.now), undefined);
  assert.equal(await store.transitionOrder(first.order.id, f.passenger.id, "cancelled"), undefined);
  await assertIdle(f, 0);
});

for (const operation of ["join", "leave"]) {
  test(`PostgreSQL an offer winning against ${operation} preserves the reservation`, { timeout: 15_000 }, async t => {
    const f = await fixture(t, { driverSeats: [4] });
    const original = await store.getQueueEntry(f.drivers[0].id);
    const [offered, outcome] = await overlapping("tezjet_driver_queue", "driver_id", f.drivers[0].id, [
      () => store.dispatchOrderOffer(f.orders[0].id, f.now),
      () => settlement(operation === "join"
        ? otherStore.joinQueue({ ...original, availableSeats: 8 })
        : otherStore.leaveQueue(f.drivers[0].id)),
    ]);
    assert.equal(outcome.error?.statusCode, 409);
    assert.equal(outcome.error?.code, operation === "join" ? "QUEUE_BUSY" : "ACTIVE_ORDER");
    await assertPending(f, 0, offered.order);
  });
}

test("PostgreSQL a reduced-seat rejoin winning against dispatch prevents the offer", { timeout: 15_000 }, async t => {
  const f = await fixture(t, { driverSeats: [4] });
  const original = await store.getQueueEntry(f.drivers[0].id);
  const [joined, offered] = await overlapping("tezjet_driver_queue", "driver_id", f.drivers[0].id, [
    () => store.joinQueue({ ...original, availableSeats: 1 }),
    () => otherStore.dispatchOrderOffer(f.orders[0].id, f.now),
  ]);
  assert.equal(joined.availableSeats, 1);
  assert.equal(offered, undefined);
  await assertIdle(f, 0, 1);
  assert.equal((await store.getOrder(f.orders[0].id)).offeredDriverId, undefined);
});

test("PostgreSQL leaving before dispatch cannot reserve seats on a deleted queue row", { timeout: 15_000 }, async t => {
  const f = await fixture(t, { driverSeats: [4] });
  const [, offered] = await overlapping("tezjet_driver_queue", "driver_id", f.drivers[0].id, [
    () => store.leaveQueue(f.drivers[0].id),
    () => otherStore.dispatchOrderOffer(f.orders[0].id, f.now),
  ]);
  assert.equal(offered, undefined);
  assert.equal(await store.getQueueEntry(f.drivers[0].id), undefined);
  assert.equal((await store.getOrder(f.orders[0].id)).offeredDriverId, undefined);
});

test("PostgreSQL a new Store recovers pending offers in driver lists and continues their deadline", async t => {
  const f = await fixture(t);
  const first = await store.dispatchOrderOffer(f.orders[0].id, f.now);
  const restarted = new PostgresStore();
  await restarted.initialize();
  assert.deepEqual(await restarted.getOrder(first.order.id), await store.getOrder(first.order.id));
  assert.equal((await restarted.getQueueEntry(f.drivers[0].id)).pendingOfferOrderId, first.order.id);
  assert.ok((await restarted.listOrdersForUser(f.drivers[0].id)).some(order => order.id === first.order.id), "The driver list restores a live offer after restart.");
  assert.ok(!(await restarted.listOrdersForUser(f.drivers[1].id)).some(order => order.id === first.order.id));
  const [next] = await restarted.processOrderOffers(first.order.offerExpiresAt);
  assert.equal(next.previousDriverId, f.drivers[0].id);
  assert.equal(next.order.offeredDriverId, f.drivers[1].id);
  await assertIdle(f, 0);
  await assertPending(f, 1, next.order);
});

test("PostgreSQL revoking approval blocks acceptance and immediately advances the live offer", async t => {
  const f = await fixture(t);
  const first = await store.dispatchOrderOffer(f.orders[0].id, f.now);
  await otherStore.setDriverApproval(f.drivers[0].id, "rejected");
  assert.equal(await store.acceptOrderOffer(first.order.id, f.drivers[0].id, f.now + 1), undefined);
  const [next] = await otherStore.processOrderOffers(f.now + 1);
  assert.equal(next.previousDriverId, f.drivers[0].id);
  assert.equal(next.order.offeredDriverId, f.drivers[1].id);
  await assertIdle(f, 0);
  await assertPending(f, 1, next.order);
});

test("PostgreSQL queue-only expiry and dispatch acquire queue rows in the same canonical order", { timeout: 15_000 }, async t => {
  const f = await fixture(t, { orderCount: 0 });
  // Reinsert in reverse driver-ID order to make physical order disagree with
  // the canonical acquisition order used by both production operations.
  const entries = await Promise.all(f.drivers.map(driver => store.getQueueEntry(driver.id)));
  await database.query("DELETE FROM tezjet_driver_queue WHERE driver_id = ANY($1::text[])", [f.drivers.map(driver => driver.id)]);
  for (const entry of [...entries].sort((a, b) => b.driverId.localeCompare(a.driverId))) {
    await store.joinQueue(entry);
    await store.updateQueueEntry(entry.driverId, { joinedAt: entry.joinedAt, seatLockExpiresAt: Date.now() - 1_000 });
  }
  const order = await f.createOrder();
  const lowestId = f.drivers.map(driver => driver.id).sort()[0];
  const [initialOffer] = await overlapping("tezjet_driver_queue", "driver_id", lowestId, [
    () => otherStore.dispatchOrderOffer(order.id),
    () => store.clearExpiredSeatLocks(),
  ]);
  assert.equal(initialOffer, undefined, "Expired queue locks are cleared before those drivers become eligible.");
  await assertIdle(f, 0);
  await assertIdle(f, 1);
  const offered = await store.dispatchOrderOffer(order.id);
  assert.equal(offered.order.offeredDriverId, f.drivers[0].id);
  await assertPending(f, 0, offered.order);
  await assertIdle(f, 1);
  for (const driver of f.drivers) assert.equal((await store.getQueueEntry(driver.id)).seatLockExpiresAt, undefined);
});

test("PostgreSQL Point D offers only an active in-transit pool and acceptance does not debit twice", async t => {
  const f = await fixture(t, { seats: 1 });
  const c = await store.dispatchOrderOffer(f.orders[0].id, f.now);
  await store.acceptOrderOffer(c.order.id, f.drivers[0].id, f.now + 1);
  await store.transitionOrder(c.order.id, f.drivers[0].id, "arrived_at_c");
  await store.transitionOrder(c.order.id, f.drivers[0].id, "in_transit");
  const pointD = await f.createOrder({ pickupPoint: "D", seats: 2 });
  const offered = await otherStore.dispatchOrderOffer(pointD.id, f.now + 2);
  assert.equal(offered.order.offeredDriverId, f.drivers[0].id);
  await assertPending(f, 0, offered.order, 3);
  const accepted = await store.acceptOrderOffer(pointD.id, f.drivers[0].id, f.now + 3);
  assert.equal(accepted.status, "in_transit");
  const entry = await store.getQueueEntry(f.drivers[0].id);
  assert.equal(entry.availableSeats, 1);
  assert.equal(entry.inFifo, false);
  assert.deepEqual([...entry.activeOrderIds].sort(), [c.order.id, pointD.id].sort());
  await assertIdle(f, 1);
  const oversized = await f.createOrder({ pickupPoint: "D", seats: 2 });
  assert.equal(await store.dispatchOrderOffer(oversized.id, f.now + 4), undefined, "A waiting FIFO driver is not an active Point D pool.");
});

test("PostgreSQL its partial unique index rejects two pending offers to one driver", async t => {
  const f = await fixture(t, { orderCount: 2 });
  await store.dispatchOrderOffer(f.orders[0].id, f.now);
  await assert.rejects(database.query("UPDATE tezjet_orders SET offered_driver_id = $1, offer_expires_at = $2 WHERE id = $3", [f.drivers[0].id, f.now + 60_000, f.orders[1].id]), { code: "23505" });
  assert.equal((await store.getOrder(f.orders[1].id)).offeredDriverId, undefined);
  await assertPending(f, 0, f.orders[0]);
});

test("PostgreSQL a failed offer rewrite rolls back the released and newly reserved seats", async t => {
  const f = await fixture(t);
  const first = await store.dispatchOrderOffer(f.orders[0].id, f.now);
  const beforeOrder = await store.getOrder(first.order.id);
  const beforeQueue = await store.getQueueEntry(f.drivers[0].id);
  const nextQueue = await store.getQueueEntry(f.drivers[1].id);
  const triggerName = `fail_offer_${randomUUID().replaceAll("-", "")}`;
  await database.query(`CREATE FUNCTION "${schema}"."${triggerName}"() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.id = '${first.order.id}' AND NEW.offered_driver_id = '${f.drivers[1].id}' THEN RAISE EXCEPTION 'injected offer rollback'; END IF;
      RETURN NEW;
    END $$`);
  await database.query(`CREATE TRIGGER "${triggerName}" BEFORE UPDATE ON "${schema}".tezjet_orders FOR EACH ROW EXECUTE FUNCTION "${schema}"."${triggerName}"()`);
  try {
    await assert.rejects(store.rejectOrderOffer(first.order.id, f.drivers[0].id, f.now + 1), error => {
      assert.equal(error.cause?.code, "P0001");
      assert.match(error.cause?.message ?? "", /injected offer rollback/);
      return true;
    });
    assert.deepEqual(await store.getOrder(first.order.id), beforeOrder);
    assert.deepEqual(await store.getQueueEntry(f.drivers[0].id), beforeQueue);
    assert.deepEqual(await store.getQueueEntry(f.drivers[1].id), nextQueue);
  } finally {
    await database.query(`DROP TRIGGER "${triggerName}" ON "${schema}".tezjet_orders`);
    await database.query(`DROP FUNCTION "${schema}"."${triggerName}"()`);
  }
  const next = await store.rejectOrderOffer(first.order.id, f.drivers[0].id, f.now + 1);
  await assertIdle(f, 0);
  await assertPending(f, 1, next.order);
});

test("MemoryStore preserves offer ownership, timeout progression, queue protection, and seat accounting", async t => {
  const memory = new MemoryStore();
  const f = await fixture(t, { adapter: memory });
  const first = await memory.dispatchOrderOffer(f.orders[0].id, f.now);
  assert.equal(first.order.offerExpiresAt, f.now + 60_000);
  await assertPending(f, 0, first.order);
  const snapshot = structuredClone(await memory.getQueueEntry(f.drivers[0].id));
  assert.throws(() => memory.joinQueue({ ...snapshot, availableSeats: 8 }), { statusCode: 409, code: "QUEUE_BUSY" });
  assert.throws(() => memory.leaveQueue(f.drivers[0].id), { statusCode: 409, code: "ACTIVE_ORDER" });
  assert.equal(await memory.acceptOrderOffer(first.order.id, f.drivers[1].id, f.now), undefined);
  assert.equal(await memory.acceptOrderOffer(first.order.id, f.drivers[0].id, f.now + 60_000), undefined);
  const [next] = await memory.processOrderOffers(f.now + 60_000);
  assert.equal(next.previousDriverId, f.drivers[0].id);
  assert.deepEqual(next.order.attemptedDriverIds, f.drivers.map(driver => driver.id));
  await assertIdle(f, 0);
  await assertPending(f, 1, next.order);
  const accepted = await memory.acceptOrderOffer(next.order.id, f.drivers[1].id, f.now + 60_001);
  assert.equal(accepted.status, "en_route_to_c");
  assert.equal((await memory.getQueueEntry(f.drivers[1].id)).availableSeats, 2);
  assert.deepEqual(await memory.processOrderOffers(f.now + 120_000), []);
  await memory.transitionOrder(accepted.id, f.passenger.id, "cancelled");
  await assertIdle(f, 1);
});
