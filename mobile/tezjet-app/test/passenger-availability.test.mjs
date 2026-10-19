import assert from "node:assert/strict";
import { test } from "node:test";
import { passengerAvailabilityDisplay, verifiedDriverCount } from "../lib/passenger-availability.ts";

const current = { pickup: "C", seats: 2, available: true, eligibleDriverCount: 3, checkedAt: 1000 };
const display = (overrides = {}) => passengerAvailabilityDisplay({
  availability: current, pickup: "C", seats: 2, now: 1001, checking: false, ...overrides,
});

test("driver count is accepted only when the server provides a non-negative integer", () => {
  for (const value of [-1, 2.5, NaN, Infinity, "3", null, undefined]) {
    assert.equal(verifiedDriverCount(value), null);
  }
  assert.equal(verifiedDriverCount(0), 0);
  assert.equal(verifiedDriverCount(4), 4);
});
test("fresh route-matched availability displays only verified driver counts", () => {
  assert.equal(display().label, "Подходящих водителей: 3");
  assert.equal(display().state, "available");
  assert.equal(display({ availability: { ...current, eligibleDriverCount: null } }).label,
    "Есть подходящий водитель.");
  assert.equal(display({ availability: { ...current, eligibleDriverCount: 0 } }).label,
    "Есть подходящий водитель.");
});
test("unavailable driver state does not pretend an order was placed", () => {
  assert.deepEqual(display({ availability: { ...current, available: false, eligibleDriverCount: 0 } }), {
    state: "unavailable", label: "Подходящих водителей сейчас нет.",
  });
});
test("no stale or wrong-route availability is displayed as an available driver", () => {
  assert.equal(display({ pickup: "D" }).state, "stale");
  assert.equal(display({ seats: 3 }).state, "stale");
  assert.equal(display({ now: 16000 }).state, "stale");
  assert.equal(display({ now: 999 }).state, "stale");
  assert.equal(display({ availability: null }).state, "stale");
});
test("loading and connection failures do not reuse an old available count", () => {
  assert.equal(display({ checking: true }).state, "checking");
  assert.equal(display({ error: "offline" }).state, "error");
  assert.equal(display({ checking: false, error: "offline", availability: null }).state, "error");
});
