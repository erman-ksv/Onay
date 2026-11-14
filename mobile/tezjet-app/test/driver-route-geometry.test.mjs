import assert from "node:assert/strict";
import test from "node:test";
import { orderedDriverStops, parseDriverRouteCatalog, parseDriverRouteSnapshot } from "../lib/driver-routes.ts";

const route = {
  id: "route-geometry", name: "Configured route", updatedAt: "2026-11-14T00:00:00Z",
  stops: [
    { id: "a", code: "A", name: "Start", sequence: 1, position: 1 },
    { id: "mid", code: "MID", name: "Middle", sequence: 2, position: 2 },
    { id: "b", code: "B", name: "End", sequence: 3, position: 3 },
  ],
  pitaks: { aStopCode: "A", bStopCode: "B", radiusMeters: 200 },
};
const parse = input => parseDriverRouteCatalog({ routes: [input] })[0];
const withPoint = location => ({ ...route, stops: route.stops.map((stop, index) => index === 0 ? { ...stop, location } : stop) });

test("route parsing preserves valid static coordinates including zero and geographic boundaries", () => {
  for (const location of [{ lat: 0, lng: 0 }, { lat: 90, lng: 180 }, { lat: -90, lng: -180 }, { lat: 41.3111, lng: 69.2797 }]) {
    const parsed = parse(withPoint(location));
    assert.deepEqual(parsed.stops[0].location, location);
    assert.notEqual(parsed.stops[0].location, location, "parsed point must not alias the untrusted response");
    assert.equal(Object.hasOwn(parsed.stops[1], "location"), false);
  }
});

test("historical routes without optional geometry remain unchanged and usable", () => {
  assert.deepEqual(parse(route), route);
  const partial = parse(withPoint({ lat: 0, lng: 0 }));
  assert.equal(partial.stops.length, 3);
  assert.equal(Object.hasOwn(partial.stops[1], "location"), false, "do not fabricate intermediate geometry");
  const snapshot = { choice: { routeId: route.id, direction: "a_to_b", routeUpdatedAt: route.updatedAt }, route, unavailable_reason: null };
  assert.deepEqual(parseDriverRouteSnapshot(snapshot), snapshot);
});

test("malformed optional geometry is unavailable without coercion or losing the valid route", () => {
  for (const location of [undefined, null, false, [], [0, 0], "0,0", {}, { lat: 0 }, { lng: 0 },
    { lat: "0", lng: 0 }, { lat: 0, lng: "0" }, { lat: null, lng: 0 },
    { lat: NaN, lng: 0 }, { lat: 0, lng: Infinity }, { lat: -Infinity, lng: 0 },
    { lat: 90.001, lng: 0 }, { lat: -90.001, lng: 0 }, { lat: 0, lng: 180.001 }, { lat: 0, lng: -180.001 }]) {
    const parsed = parse(withPoint(location));
    assert.deepEqual(parsed, route, `invalid point ${String(location)} must not become display geometry`);
  }
});

test("static location allowlists coordinates and never retains telemetry or extra response fields", () => {
  const parsed = parse(withPoint({ lat: 42, lng: 69, timestamp: 123, isMocked: true, token: "private", driverId: "unrelated" }));
  assert.deepEqual(parsed.stops[0].location, { lat: 42, lng: 69 });
  assert.deepEqual(Object.keys(parsed.stops[0].location), ["lat", "lng"]);
});

test("reverse direction keeps coordinates attached to original stop IDs without mutating route", () => {
  const input = { ...route, stops: route.stops.map((stop, index) => ({ ...stop, location: { lat: index, lng: 60 + index } })) };
  const parsed = parse(input);
  const reversed = orderedDriverStops(parsed, "b_to_a");
  assert.deepEqual(reversed.map(stop => [stop.id, stop.location]), [["b", { lat: 2, lng: 62 }], ["mid", { lat: 1, lng: 61 }], ["a", { lat: 0, lng: 60 }]]);
  assert.deepEqual(parsed.stops.map(stop => stop.id), ["a", "mid", "b"]);
  assert.deepEqual(parseDriverRouteSnapshot({ choice: { routeId: route.id, direction: "b_to_a", routeUpdatedAt: route.updatedAt }, route: input, unavailable_reason: null }).route, parsed);
});
