import assert from "node:assert/strict";
import { test } from "node:test";
import { driverVehicleBody, parseDriverVehicleSnapshot } from "../lib/driver-vehicle.ts";
import { parsePassengerDriver } from "../lib/passenger-driver.ts";
const car = { revision: "vehicle-1", make: "Chevrolet", model: "Cobalt", plate_number: "01 A123 BC", seat_capacity: 3, updated_at: "2026-10-21T12:00:00Z" };
test("new vehicle binds explicit null receipt; edits use the last server receipt", () => {
  assert.equal(driverVehicleBody(car, null).expected_revision, null);
  assert.equal(driverVehicleBody(car, car).expected_revision, "vehicle-1");
  assert.deepEqual(Object.keys(driverVehicleBody(car, car)).sort(), ["expected_revision", "make", "model", "plate_number", "seat_capacity"]);
});
test("missing vehicle data and invalid capacities fail before submission", () => {
  for (const bad of [{ ...car, make: "" }, { ...car, model: " " }, { ...car, plate_number: "" }, ...[0, 9, 1.5, NaN, "3"].map(seat_capacity => ({ ...car, seat_capacity }))]) assert.throws(() => driverVehicleBody(bad, null));
});
test("owner snapshot preserves server receipt and review state", () => {
  assert.deepEqual(parseDriverVehicleSnapshot({ driver_vehicle: car, approval_status: "pending" }), { driver_vehicle: car, approval_status: "pending" });
  assert.equal(parseDriverVehicleSnapshot({ driver_vehicle: null, approval_status: "approved" }).driver_vehicle, null);
});
test("malformed owner snapshots cannot be treated as confirmed vehicles", () => {
  for (const bad of [null, {}, { driver_vehicle: car, approval_status: "verified" }, ...[{ ...car, revision: "" }, { ...car, seat_capacity: 9 }, { ...car, updated_at: "bad" }].map(driver_vehicle => ({ driver_vehicle, approval_status: "approved" }))]) assert.throws(() => parseDriverVehicleSnapshot(bad));
});
test("passenger sees reviewed identity/capacity without the private owner receipt", () => {
  const raw = { driver: { id: "driver", full_name: "Алишер", phone_number: "+77771234567", vehicle: { ...car, revision: "private", updated_at: "private" } } };
  const driver = parsePassengerDriver(raw, "driver");
  assert.deepEqual(driver.vehicle, { make: "Chevrolet", model: "Cobalt", plateNumber: "01 A123 BC", seatCapacity: 3 });
  assert.equal(JSON.stringify(driver).includes("private"), false);
  for (const vehicle of [null, {}, { ...car, seat_capacity: 99 }]) assert.throws(() => parsePassengerDriver({ driver: { ...raw.driver, vehicle } }, "driver"));
});
