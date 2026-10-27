import assert from "node:assert/strict";
import { test } from "node:test";
import { ridePickupLabel, rideDestinationLabel } from "../lib/orders.ts";

test("a booked intermediate stop is displayed instead of its driver FIFO lane", () => {
  const order = { id: "segment", status: "searching", pickup_point: "A", seats: 2,
    fare: { pickupStop: { name: "Посёлок C" }, destinationStop: { name: "Питак B" } }, destination: "Питак B" };
  assert.equal(ridePickupLabel(order), "Посёлок C");
  assert.equal(rideDestinationLabel(order), "Питак B");
  assert.equal(order.pickup_point, "A", "Dispatch identity is not rewritten by display logic.");
});

test("legacy pickup addresses and destination descriptions remain visible", () => {
  const order = { id: "legacy", status: "searching", pickup_point: "C", seats: 1,
    pickup_address: "У дома 12", destination: "Рынок", fare: { pickupStop: { name: "Остановка C" } } };
  assert.equal(ridePickupLabel(order), "У дома 12");
  assert.equal(rideDestinationLabel(order), "Рынок");
  assert.equal(ridePickupLabel({ ...order, pickup_address: undefined, fare: undefined }), "C");
});

test("missing or malformed labels have a readable fallback", () => {
  const order = { id: "partial", status: "searching", pickup_point: "B", seats: 1,
    pickup_address: " ", destination: "", fare: { pickupStop: { name: {} }, destinationStop: { name: "Село" } } };
  assert.equal(ridePickupLabel(order), "B");
  assert.equal(rideDestinationLabel(order), "Село");
  assert.equal(ridePickupLabel({ ...order, pickup_point: null }), "Место посадки");
  assert.equal(rideDestinationLabel({ ...order, fare: null }), "По маршруту");
});
