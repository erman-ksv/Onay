import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createDemoRide, createDemoState, onayDemoReducer, onayDemoPreviewEnabled } from "../lib/onay-demo.ts";
import buildConfig from "../app.config.ts";

test("offline preview needs an explicit boolean flag; ordinary builds remain live-auth only", t => {
  for (const extra of [undefined, null, {}, { onayDemoPreview: false }, { onayDemoPreview: "true" }, { onayDemoPreview: 1 }]) assert.equal(onayDemoPreviewEnabled(extra), false);
  assert.equal(onayDemoPreviewEnabled({ onayDemoPreview: true }), true);
  const previous = process.env.ONAY_DEMO_PREVIEW;
  t.after(() => previous === undefined ? delete process.env.ONAY_DEMO_PREVIEW : process.env.ONAY_DEMO_PREVIEW = previous);
  for (const value of [undefined, "false", "TRUE", "1", "true"]) {
    value === undefined ? delete process.env.ONAY_DEMO_PREVIEW : process.env.ONAY_DEMO_PREVIEW = value;
    const result = buildConfig({ config: { name: "Onay", slug: "tezjet", extra: { existing: "kept" } } });
    assert.equal(result.extra.onayDemoPreview, value === "true");
    assert.equal(result.extra.existing, "kept");
  }
});

test("demo examples are clearly labelled, bounded and independent on every entry", () => {
  const a = createDemoState("passenger"), b = createDemoState("driver");
  assert.equal(a.ride, null); assert.equal(b.role, "driver");
  a.history.length = 0; assert.equal(b.history.length, 1);
  for (const seats of [0, 9, -1, NaN, 1.5]) assert.throws(() => createDemoRide(seats));
  const reverse = createDemoRide(3, "searching", true);
  assert.match(reverse.pickup_point, /ДЕМО.*Gazalkent/);
  assert.match(reverse.destination, /ДЕМО.*Shaxsham/);
  assert.deepEqual([reverse.fare.total, reverse.fare.currency], [36000, "UZS"]);
});

test("demo ride transitions stay local, ignore duplicate clicks and preserve history once", () => {
  let state = createDemoState("driver");
  state = onayDemoReducer(state, { type: "start", seats: 2 });
  const first = state;
  assert.equal(onayDemoReducer(state, { type: "start", seats: 1 }), first);
  for (const expectedStatus of ["searching", "en_route_to_c", "arrived_at_c", "boarded_waiting", "in_transit"]) {
    state = onayDemoReducer(state, { type: "advance", expectedStatus });
    assert.equal(onayDemoReducer(state, { type: "advance", expectedStatus }), state);
  }
  assert.equal(state.ride, null); assert.equal(state.history.length, 2);
  assert.equal(state.history[0].status, "completed");
  state = onayDemoReducer(state, { type: "start", seats: 1 });
  state = onayDemoReducer(state, { type: "cancel", expectedStatus: "searching" });
  assert.equal(state.ride, null); assert.equal(state.history[0].status, "cancelled");
  assert.equal(state.history.filter(row => row.id === "onay-demo-ride").length, 1);
});

test("preview reducer and UI contain no auth transport or credential persistence", () => {
  const source = ["../lib/onay-demo.ts", "../components/OnayDemoApp.tsx"].map(path => readFileSync(new URL(path, import.meta.url), "utf8")).join("\n");
  for (const forbidden of ["fetch(", "request(", "AsyncStorage", "localStorage", "socket.io", "access_token", "/api/"]) assert.ok(!source.includes(forbidden), forbidden);
  const app = readFileSync(new URL("../app/index.tsx", import.meta.url), "utf8");
  assert.match(app, /demoRole && enabled\s*\? <OnayDemoApp/);
  assert.match(app, /: <LiveOnayApp onDemo=\{enabled \? setDemoRole : undefined\}/);
  assert.match(app, /onExit=\{\(\) => setDemoRole\(null\)\}/);
});
