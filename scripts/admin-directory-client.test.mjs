import test from "node:test";
import assert from "node:assert/strict";
import { AdminApiError, filterDirectory, loadDirectories, setDriverBlocked } from "../artifacts/mockup-sandbox/src/admin/api.ts";

const passenger = { id: "person-1", full_name: "Алишер Каримов", phone_number: "+998901234567", role: "passenger", roles: ["passenger"], created_at: "2026-10-28" };
const driver = { ...passenger, id: "driver-2", role: "driver", roles: ["passenger", "driver"] };
const reply = (payload, status = 200) => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
async function mocked(fn, run) { const previous = globalThis.fetch; globalThis.fetch = fn; try { await run(); } finally { globalThis.fetch = previous; } }

test("Directory search handles names, IDs and formatted phone numbers without changing the snapshot", () => {
  const users = [passenger, driver], before = structuredClone(users);
  for (const query of ["  АЛИШЕР  ", "+998 (90) 123-45-67", "90 123 45", "998901234567"]) assert.equal(filterDirectory(users, query).length, 2);
  assert.deepEqual(filterDirectory(users, "DRIVER-2"), [driver]);
  assert.deepEqual(filterDirectory(users, "nobody"), []);
  assert.deepEqual(filterDirectory(users, "---"), []);
  assert.deepEqual(filterDirectory(users, "   "), users);
  assert.deepEqual(users, before);
});

test("Both directory reads start concurrently and keep credentials/search data out of URLs", async () => {
  const calls = [];
  let resolvePassengers;
  await mocked((url, options) => {
    calls.push(url);
    assert.equal(options.headers.Authorization, "Bearer private-session");
    assert.equal(options.credentials, "omit");
    assert.equal(options.cache, "no-store");
    if (url === "/api/admin/passengers") return new Promise(resolve => { resolvePassengers = resolve; });
    assert.equal(url, "/api/admin/drivers");
    return Promise.resolve(reply({ drivers: [driver] }));
  }, async () => {
    const pending = loadDirectories("private-session");
    assert.equal(calls.length, 2);
    resolvePassengers(reply({ passengers: [passenger, driver] }));
    assert.deepEqual(await pending, { passengers: [passenger, driver], drivers: [driver] });
  });
});

test("Malformed, duplicated or wrong-capability directory responses reject the entire snapshot", async () => {
  for (const passengers of [null, {}, [null], [passenger, passenger], [{ ...passenger, phone_number: null }], [{ ...passenger, roles: ["driver"] }]]) {
    await mocked(async url => reply(url.endsWith("passengers") ? { passengers } : { drivers: [driver] }),
      () => assert.rejects(loadDirectories("session"), error => error instanceof AdminApiError && error.status === 502));
  }
  await mocked(async url => reply(url.endsWith("passengers") ? { passengers: [passenger] } : null),
    () => assert.rejects(loadDirectories("session"), error => error instanceof AdminApiError && error.status === 502));
});

test("One failed directory read cannot produce a partial snapshot or automatic retry", async () => {
  let count = 0;
  await mocked(async url => {
    count++;
    if (url.endsWith("drivers")) throw new TypeError("transport interrupted");
    return reply({ passengers: [passenger] });
  }, async () => {
    await assert.rejects(loadDirectories("session"), /transport interrupted/);
    assert.equal(count, 2);
  });
  for (const status of [401, 403, 503]) await mocked(async () => reply({ error: { message: "Denied" } }, status),
    () => assert.rejects(loadDirectories("session"), error => error instanceof AdminApiError && error.status === status));
});

test("Directory cancellation propagates to both actual read options", async () => {
  const controller = new AbortController();
  await mocked(async (url, options) => {
    assert.equal(options.signal, controller.signal);
    if (options.signal.aborted) throw new DOMException("Aborted", "AbortError");
    return reply(url.endsWith("passengers") ? { passengers: [] } : { drivers: [] });
  }, async () => {
    controller.abort();
    await assert.rejects(loadDirectories("session", controller.signal), error => error.name === "AbortError");
  });
});

test("Driver block commands capture explicit choice, encoded ID and car revision with private authentication", async () => {
  for (const blocked of [true, false]) await mocked(async (url, options) => {
    assert.equal(url, "/api/admin/drivers/" + encodeURIComponent("driver /?") + "/block");
    assert.equal(options.method, "PATCH"); assert.equal(options.headers.Authorization, "Bearer private-session");
    assert.equal(options.cache, "no-store"); assert.equal(options.credentials, "omit");
    assert.deepEqual(JSON.parse(options.body), { blocked, expected_vehicle_revision: null });
    return reply({ driver: { ...driver, id: "driver /?", driver_approval_status: blocked ? "blocked" : "pending" } });
  }, async () => assert.equal((await setDriverBlocked("private-session", "driver /?", blocked, null)).driver_approval_status, blocked ? "blocked" : "pending"));
});

test("Wrong driver, receipt or block decision cannot be reported as confirmed", async () => {
  for (const value of [null, {}, { ...driver, driver_approval_status: "approved" },
    { ...driver, id: "other", driver_approval_status: "blocked" },
    { ...driver, driver_approval_status: "blocked", driver_vehicle: { revision: "different" } }]) {
    await mocked(async () => reply({ driver: value }), () => assert.rejects(setDriverBlocked("session", driver.id, true, null), error => error instanceof AdminApiError && error.status === 502));
  }
});

test("Driver block errors and unknown outcomes never automatically retry", async () => {
  for (const status of [401, 403, 404, 409, 503]) {
    let calls = 0;
    await mocked(async () => { calls++; return reply({ error: { code: "VEHICLE_REVIEW_CHANGED" } }, status); },
      () => assert.rejects(setDriverBlocked("session", driver.id, true, null), error => error instanceof AdminApiError && error.status === status));
    assert.equal(calls, 1);
  }
  let calls = 0;
  await mocked(async () => { calls++; throw new TypeError("Lost response"); },
    () => assert.rejects(setDriverBlocked("session", driver.id, true, null), TypeError));
  assert.equal(calls, 1);
});
