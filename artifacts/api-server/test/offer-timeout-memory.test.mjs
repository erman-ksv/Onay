import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let directory, MemoryStore;
before(async () => {
  directory = await mkdtemp(path.join(root, ".offer-policy-memory-"));
  const outfile = path.join(directory, "production.mjs");
  await build({ stdin: { contents: 'export { MemoryStore } from "./src/store/memoryStore";', resolveDir: root, loader: "ts" },
    outfile, bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "silent" });
  ({ MemoryStore } = await import(pathToFileURL(outfile).href));
});
after(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });
async function fixture() {
  const store = new MemoryStore();
  const admin = await store.createUser({ role: "admin", fullName: "Policy admin", phoneNumber: "policy-admin", locale: "ru" });
  return { store, admin, actor: { adminId: admin.id, expectedSessionVersion: admin.sessionVersion } };
}

test("Memory policy defaults are isolated snapshots and explicit same-value save persists a receipt once", async () => {
  const { store, actor } = await fixture();
  const initial = store.getOfferTimeout();
  assert.equal(initial.revision, null);
  const saved = store.setOfferTimeoutAsAdmin(initial.seconds, null, actor);
  assert.ok(saved.revision); assert.equal(saved.seconds, initial.seconds);
  assert.deepEqual(store.setOfferTimeoutAsAdmin(saved.seconds, saved.revision, actor), saved);
  assert.equal(store.listAdminAuditEvents().length, 1);
  saved.seconds = 999;
  assert.equal(store.getOfferTimeout().seconds, initial.seconds);
});

test("Memory policy rejects invalid, stale, non-admin and revoked changes without state or audit effects", async () => {
  const { store, admin, actor } = await fixture(), original = store.getOfferTimeout();
  for (const value of [0, -1, 3601, 1.5, "60", true, null, NaN, Infinity]) {
    assert.throws(() => store.setOfferTimeoutAsAdmin(value, null, actor), error => error.code === "VALIDATION_ERROR");
  }
  const passenger = store.createUser({ role: "passenger", fullName: "Policy passenger", phoneNumber: "policy-passenger", locale: "ru" });
  assert.throws(() => store.setOfferTimeoutAsAdmin(90, null, { adminId: passenger.id, expectedSessionVersion: 0 }), error => error.code === "FORBIDDEN");
  assert.throws(() => store.setOfferTimeoutAsAdmin(90, "stale", actor), error => error.code === "OFFER_TIMEOUT_CHANGED");
  store.invalidateSessions(admin.id);
  assert.throws(() => store.setOfferTimeoutAsAdmin(90, null, actor), error => error.code === "UNAUTHORIZED");
  assert.deepEqual(store.getOfferTimeout(), original); assert.equal(store.listAdminAuditEvents().length, 0);
});

test("Memory policy accepts both bounds and rejects a stale same-value write instead of silently overwriting", async () => {
  const { store, actor } = await fixture();
  const first = store.setOfferTimeoutAsAdmin(1, null, actor);
  const next = store.setOfferTimeoutAsAdmin(3600, first.revision, actor);
  assert.equal(next.seconds, 3600); assert.notEqual(first.revision, next.revision);
  assert.throws(() => store.setOfferTimeoutAsAdmin(3600, first.revision, actor), error => error.code === "OFFER_TIMEOUT_CHANGED");
  assert.equal(store.listAdminAuditEvents().length, 2);
});

test("Memory new offers use current policy while an existing offer remains frozen", async () => {
  const { store, actor } = await fixture();
  const passenger = store.createUser({ role: "passenger", fullName: "Policy passenger", phoneNumber: "offer-passenger", locale: "ru" });
  for (let index = 0; index < 2; index++) {
    const driver = store.createUser({ role: "driver", fullName: "Policy driver", phoneNumber: "offer-driver-" + index, locale: "ru" });
    store.setDriverApproval(driver.id, "approved");
    store.joinQueue({ driverId: driver.id, joinedAt: index, status: "searching", availableSeats: 3,
      lastLocation: { lat: 41.3111, lng: 69.2797, timestamp: Date.now() }, priorityLock: false, inFifo: true, activeOrderIds: [] });
  }
  const route = store.getRoute("pyatak"), stops = route.stops;
  const input = { passengerId: passenger.id, passengerPhone: passenger.phoneNumber, pickupPoint: "C", pickupLocation: { lat: 41.3111, lng: 69.2797, timestamp: Date.now() },
    routeStops: stops, fare: { currency: "KZT", routeId: route.id, pickupStop: stops[0], destinationStop: stops[1], totalKzt: 500 }, destination: "D", seats: 1, status: "searching" };
  const first = store.createOrderWithOffer(input), deadline = first.offerExpiresAt;
  const setting = store.setOfferTimeoutAsAdmin(75, null, actor);
  assert.equal(store.dispatchOrderOffer(first.id), undefined);
  assert.equal(store.getOrder(first.id).offerExpiresAt, deadline);
  const clock = Date.parse(first.createdAt) + 100;
  const moved = store.rejectOrderOffer(first.id, first.offeredDriverId, clock);
  assert.ok(moved.order.offeredDriverId); assert.equal(moved.order.offerExpiresAt - clock, setting.seconds * 1000);
});
