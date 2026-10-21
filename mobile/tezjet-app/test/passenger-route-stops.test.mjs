import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isFreshPassengerRouteQuote, passengerRouteAvailabilityPath, passengerRouteOrderBody,
  passengerRouteSelection, passengerRouteSelectionKey,
} from "../lib/passenger-route-orders.ts";

const route = {
  id: "village-city", name: "Село — город", updatedAt: "2026-10-21T11:00:00.000Z",
  stops: [
    { id: "a", code: "A", name: "Село", sequence: 1, position: 1 },
    { id: "c", code: "C", name: "Посёлок", sequence: 2, position: 2 },
    { id: "d", code: "D", name: "Рынок", sequence: 3, position: 3 },
    { id: "b", code: "B", name: "Город", sequence: 4, position: 4 },
  ],
  pitaks: { aStopCode: "A", bStopCode: "B", radiusMeters: 175 },
};
const segment = (pickupStopId, destinationStopId) => ({ pickupStopId, destinationStopId });

test("existing full-line callers retain the no-selector request contract", () => {
  for (const direction of ["a_to_b", "b_to_a"]) {
    const selected = passengerRouteSelection(route, direction, 2);
    assert.deepEqual(selected, {
      route_id: route.id, direction, expected_updated_at: route.updatedAt, seats: 2,
    });
    const url = new URL(passengerRouteAvailabilityPath(selected), "https://onay.example");
    assert.equal(url.searchParams.has("pickup_stop_id"), false);
    assert.equal(url.searchParams.has("destination_stop_id"), false);
  }
});

test("passenger can book A to C or C to B in the forward direction", () => {
  for (const [pickup, destination] of [["a", "c"], ["c", "b"]]) {
    const selected = passengerRouteSelection(route, "a_to_b", 3, segment(pickup, destination));
    assert.equal(selected.pickup_stop_id, pickup);
    assert.equal(selected.destination_stop_id, destination);
    assert.equal(selected.direction, "a_to_b");
    assert.equal(selected.seats, 3);
  }
});

test("reverse-direction bookings follow B to C and C to A without mutating the catalog", () => {
  const before = structuredClone(route);
  for (const [pickup, destination] of [["b", "c"], ["c", "a"]]) {
    const selected = passengerRouteSelection(route, "b_to_a", 1, segment(pickup, destination));
    assert.equal(selected.pickup_stop_id, pickup);
    assert.equal(selected.destination_stop_id, destination);
    assert.equal(selected.direction, "b_to_a");
  }
  assert.deepEqual(route, before);
});

test("unknown, empty, partial and identical stop selectors cannot become an order", () => {
  for (const invalid of [segment("unknown", "b"), segment("a", "other-route-stop"),
    segment("", "b"), segment("a", ""), segment(" ", "b"), segment("c", "c"),
    { pickupStopId: "a" }, { destinationStopId: "b" }, {}]) {
    assert.throws(() => passengerRouteSelection(route, "a_to_b", 1, invalid));
  }
});

test("destination must be after pickup in the passenger's selected direction", () => {
  for (const [direction, pickup, destination] of [
    ["a_to_b", "b", "a"], ["a_to_b", "d", "c"],
    ["b_to_a", "a", "b"], ["b_to_a", "c", "d"],
  ]) {
    assert.throws(() => passengerRouteSelection(route, direction, 1, segment(pickup, destination)));
  }
});

test("changing either stop invalidates an otherwise fresh price and driver quote", () => {
  const original = passengerRouteSelection(route, "a_to_b", 2, segment("a", "d"));
  const quote = { key: passengerRouteSelectionKey(original), checkedAt: 1_000, value: { available: true } };
  assert.equal(isFreshPassengerRouteQuote(quote, passengerRouteSelectionKey(original), 2_000), true);
  for (const changed of [segment("c", "d"), segment("a", "b")]) {
    const nextKey = passengerRouteSelectionKey(passengerRouteSelection(route, "a_to_b", 2, changed));
    assert.notEqual(nextKey, quote.key);
    assert.equal(isFreshPassengerRouteQuote(quote, nextKey, 2_000), false);
  }
});

test("availability URL and booking POST preserve identical stop IDs with URL encoding", () => {
  const special = structuredClone(route);
  special.id = "линия A/B?x=1";
  special.stops[1].id = "c/посёлок ?+&";
  const selected = passengerRouteSelection(special, "a_to_b", 2, segment(special.stops[1].id, "b"));
  const location = { lat: 42.9, lng: 71.3, timestamp: 1_000 };
  const body = passengerRouteOrderBody(selected, location);
  const url = new URL(passengerRouteAvailabilityPath(selected), "https://onay.example");
  assert.equal(url.pathname, "/api/orders/route/availability");
  for (const field of ["route_id", "direction", "expected_updated_at", "pickup_stop_id", "destination_stop_id"]) {
    assert.equal(url.searchParams.get(field), body[field]);
  }
  assert.equal(url.searchParams.get("seats"), String(body.seats));
  assert.deepEqual(body, { ...selected, pickup_location: location });
  assert.equal(Object.hasOwn(body, "fare"), false);
  assert.equal(Object.hasOwn(body, "price"), false);
});

test("catalog version and administrator stop order remain authoritative for a segment", () => {
  const selected = passengerRouteSelection(route, "a_to_b", 2, segment("c", "d"));
  const changed = structuredClone(route);
  changed.updatedAt = "2026-10-21T11:01:00.000Z";
  const updated = passengerRouteSelection(changed, "a_to_b", 2, segment("c", "d"));
  assert.equal(updated.expected_updated_at, changed.updatedAt);
  assert.notEqual(passengerRouteSelectionKey(updated), passengerRouteSelectionKey(selected));
  changed.stops = [changed.stops[0], changed.stops[2], changed.stops[1], changed.stops[3]]
    .map((stop, index) => ({ ...stop, sequence: index + 1, position: index + 1 }));
  assert.throws(() => passengerRouteSelection(changed, "a_to_b", 2, segment("c", "d")));
  const reordered = passengerRouteSelection(changed, "a_to_b", 2, segment("d", "c"));
  assert.equal(reordered.pickup_stop_id, "d");
  assert.equal(reordered.destination_stop_id, "c");
});
