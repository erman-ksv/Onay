import assert from "node:assert/strict";
import test from "node:test";
import { passengerPositionWithDeadline } from "../lib/passenger-location.ts";
import { createPassengerRouteSubmissionGuard } from "../lib/passenger-route-orders.ts";

test("unavailable GPS releases the booking gate without posting, even if GPS resolves late", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const guard = createPassengerRouteSubmissionGuard();
  let resolvePosition;
  const provider = new Promise(resolve => { resolvePosition = resolve; });
  let posts = 0;
  async function submit() {
    if (!guard.tryStart()) return;
    try {
      await passengerPositionWithDeadline(() => provider);
      posts++;
    } finally { guard.finish(); }
  }
  const attempt = submit();
  const rejected = assert.rejects(attempt, /местоположение вовремя/);
  context.mock.timers.tick(14_999);
  assert.equal(guard.isInFlight(), true);
  context.mock.timers.tick(1);
  await rejected;
  assert.equal(guard.isInFlight(), false);
  resolvePosition({ coords: { latitude: 42, longitude: 69 } });
  await Promise.resolve();
  assert.equal(posts, 0);
});

test("location success returns the original fix and clears the timeout", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const clear = context.mock.method(globalThis, "clearTimeout");
  const fix = { coords: { latitude: 42, longitude: 69 }, timestamp: 123 };
  assert.equal(await passengerPositionWithDeadline(async () => fix), fix);
  assert.equal(clear.mock.callCount(), 1);
  assert.notEqual(clear.mock.calls[0].arguments[0], undefined);
  context.mock.timers.tick(15_000);
});

test("provider failure is preserved and clears the timeout", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const clear = context.mock.method(globalThis, "clearTimeout");
  const failure = new Error("Location services disabled");
  await assert.rejects(passengerPositionWithDeadline(async () => { throw failure; }), error => error === failure);
  assert.equal(clear.mock.callCount(), 1);
});

test("late provider rejection after timeout is handled", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let rejectPosition;
  const provider = new Promise((_, reject) => { rejectPosition = reject; });
  const rejected = assert.rejects(passengerPositionWithDeadline(() => provider), /местоположение вовремя/);
  await Promise.resolve();
  context.mock.timers.tick(15_000);
  await rejected;
  rejectPosition(new Error("late native failure"));
  await Promise.resolve();
});
