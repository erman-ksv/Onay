import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePassengerHistory, passengerHistoryDate } from "../lib/passenger-history.ts";

const ride = (id, extra = {}) => ({ id, passenger_id: "p", status: "completed", seats: 2, pickup_point: "A", destination: "B", created_at: "2026-10-30T12:00:00Z", fare: { currency: "UZS", total: 5000 }, ...extra });
const parse = orders => parsePassengerHistory({ orders }, "p");

test("full passenger history exceeds three records and includes completed and cancelled", () => {
  const rows = parse(Array.from({ length: 45 }, (_, i) => ride(String(i), { status: i % 2 ? "cancelled" : "completed" })));
  assert.equal(rows.length, 45); assert.equal(rows.filter(x => x.order.status === "cancelled").length, 22);
});
test("driver work, offers, other passengers and active orders never enter passenger history", () => {
  const rows = parse([ride("own"), ride("driver", { passenger_id: "other", driver_id: "p" }),
    ride("offer", { passenger_id: "other", offered_driver_id: "p" }), ride("live", { status: "in_transit" })]);
  assert.deepEqual(rows.map(x => x.order.id), ["own"]);
});
test("each frozen fare retains exact amount and currency independently of seats", () => {
  assert.deepEqual(parse([ride("u"), ride("k", { fare: { currency: "KZT", totalKzt: 3000 } })]).map(x => x.money),
    [{ total: 3000, currency: "KZT" }, { total: 5000, currency: "UZS" }]);
});
test("legacy absent or invalid fares remain visible as unavailable, never fabricated zero", () => {
  for (const fare of [undefined, null, { currency: "UZS", total: -1 }, { currency: "UZS", total: 3000, totalKzt: 3000 }]) {
    assert.equal(parse([ride("x", { fare })])[0].money, null);
  }
  assert.equal(parse([ride("free", { fare: { currency: "UZS", total: 0 } })])[0].money.total, 0);
});
test("creation time determines newest-first order without mutating source or using updated status time", () => {
  const orders = [ride("old", { created_at: "2026-10-29T12:00:00Z", updated_at: "2026-11-01T12:00:00Z" }), ride("new")];
  assert.deepEqual(parse(orders).map(x => x.order.id), ["new", "old"]); assert.equal(orders[0].id, "old");
});
test("empty and malformed snapshots remain distinct, duplicates cannot inflate history", () => {
  assert.deepEqual(parse([]), []);
  for (const value of [null, {}, { orders: null }, { orders: [null] }, { orders: [ride("x"), ride("x")] }, { orders: [ride(1)] }]) assert.throws(() => parsePassengerHistory(value, "p"));
  assert.throws(() => parsePassengerHistory({ orders: [] }, ""));
});
test("invalid seats fail closed and malformed dates get an explicit unavailable label", () => {
  for (const seats of [0, 9, 1.5, "2", undefined]) assert.throws(() => parse([ride("x", { seats })]));
  for (const date of [undefined, {}, "wrong", ""]) assert.equal(passengerHistoryDate(date), "Дата недоступна");
  assert.notEqual(passengerHistoryDate("2026-10-30T12:00:00Z"), "Дата недоступна");
});
