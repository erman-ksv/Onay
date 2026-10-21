import assert from "node:assert/strict";
import { test } from "node:test";
import { canReadDriverContact, parsePassengerDriver, createPassengerDriverClient, createPassengerDriverScope } from "../lib/passenger-driver.ts";
const payload = { driver: { id: "driver-1", full_name: " Алишер ", phone_number: "+77771234567" } };

test("only accepted active assignments may render a driver contact", () => {
  for (const status of ["en_route_to_c", "arrived_at_c", "boarded_waiting", "in_transit"]) {
    assert.equal(canReadDriverContact({ status, driver_id: "driver-1" }), true);
    assert.equal(canReadDriverContact({ status }), false);
  }
  for (const status of ["searching", "completed", "cancelled", "unknown"])
    assert.equal(canReadDriverContact({ status, driver_id: "driver-1" }), false);
});

test("contact parsing retains only the expected assigned driver's public fields", () => {
  const driver = parsePassengerDriver({ driver: { ...payload.driver, sessionVersion: 9, lastLocation: { lat: 42 }, roles: ["driver"], private: "not-for-client" } }, "driver-1");
  assert.deepEqual(driver, { id: "driver-1", fullName: "Алишер", phoneNumber: "+77771234567" });
  assert.equal(JSON.stringify(driver).includes("not-for-client"), false);
  assert.throws(() => parsePassengerDriver(payload, "another-driver"));
});

test("malformed contact and telephone command injection fail closed", () => {
  for (const value of [null, [], {}, { driver: [] }, { driver: { ...payload.driver, id: "another" } },
    ...["tel:+77771234567", "+7777;123", "+7777#123", "+7777*123", "https://evil.invalid", "", 123]
      .map(phone_number => ({ driver: { ...payload.driver, phone_number } })),
    { driver: { ...payload.driver, full_name: "x".repeat(201) } }])
    assert.throws(() => parsePassengerDriver(value, "driver-1"));
});

test("client binds endpoint/token/order and abort signal without cache or caller header overrides", async () => {
  const calls = [], controller = new AbortController();
  const load = createPassengerDriverClient("https://onay.example", "session-1", async (url, init) => {
    calls.push({ url, init }); return { ok: true, json: async () => payload };
  });
  assert.equal((await load("order/with?query", "driver-1", controller.signal)).id, "driver-1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://onay.example/api/orders/order%2Fwith%3Fquery/driver");
  assert.deepEqual(calls[0].init.headers, { Accept: "application/json", Authorization: "Bearer session-1" });
  assert.equal(calls[0].init.cache, "no-store");
  assert.equal(calls[0].init.signal, controller.signal);
});

test("contact client rejects unsafe API roots before any private request", () => {
  for (const endpoint of ["http://remote.example", "https://user:pass@onay.example", "https://onay.example/api", "https://onay.example?token=x", "https://onay.example#fragment", "file:///tmp/source"]) {
    assert.throws(() => createPassengerDriverClient(endpoint, "session"));
  }
  assert.throws(() => createPassengerDriverClient("https://onay.example", ""));
});

test("HTTP failures and malformed JSON cannot surface server internals or retain a contact", async () => {
  for (const status of [401, 403, 404, 429, 500]) {
    let parsed = false;
    const load = createPassengerDriverClient("http://127.0.0.1:5000", "session", async () => ({ ok: false, status, json() { parsed = true; throw Error("private SQL / token"); } }));
    await assert.rejects(load("order", "driver-1", new AbortController().signal), error => !/private SQL|token/.test(error.message));
    assert.equal(parsed, false);
  }
  const load = createPassengerDriverClient("https://onay.example", "session", async () => ({ ok: true, json() { throw Error("private raw body"); } }));
  await assert.rejects(load("order", "driver-1", new AbortController().signal), error => !error.message.includes("private raw body"));
});

test("reassignment or session replacement invalidates a delayed contact even if fetch ignores abort", async () => {
  const scope = createPassengerDriverScope();
  const old = scope.start();
  let resolve;
  const delayed = new Promise(done => { resolve = done; });
  let displayed = null;
  const obsolete = (async () => { const value = await delayed; if (scope.isCurrent(old)) displayed = value; })();
  const current = scope.start();
  assert.equal(old.signal.aborted, true);
  resolve(payload.driver);
  await obsolete;
  assert.equal(displayed, null);
  assert.equal(scope.isCurrent(current), true);
  scope.cancel();
  assert.equal(current.signal.aborted, true);
  assert.equal(scope.isCurrent(current), false);
});
