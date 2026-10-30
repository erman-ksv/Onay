import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDriverHistory } from "../lib/driver-history.ts";

const ride = (id, extra = {}) => ({ id, driver_id: "d", status: "completed", seats: 3, pickup_point: "A", destination: "B", updated_at: "2026-10-30T12:00:00Z", fare: { currency: "UZS", total: 25000 }, ...extra });
const parse = orders => parseDriverHistory({ orders }, "d");

test("history includes only closed assigned work, excluding offers and passenger-role rides", () => {
  const result = parse([ride("done"), ride("cancel", { status: "cancelled" }), ride("active", { status: "in_transit" }),
    ride("offered", { driver_id: undefined, offered_driver_id: "d" }), ride("own-passenger", { driver_id: "other", passenger_id: "d" })]);
  assert.deepEqual(result.rows.map(x => x.order.id), ["cancel", "done"]);
  assert.equal(result.completed, 1);
  assert.deepEqual(result.totals, [{ currency: "UZS", total: 25000 }]);
});
test("frozen total is summed once per order, without multiplying by seats or mixing currencies", () => {
  assert.deepEqual(parse([ride("a"), ride("b", { seats: 2 }), ride("k", { fare: { currency: "KZT", totalKzt: 4000 } })]).totals,
    [{ currency: "KZT", total: 4000 }, { currency: "UZS", total: 50000 }]);
});
test("cancelled fare never contributes even when missing or large", () => {
  assert.deepEqual(parse([ride("a"), ride("c", { status: "cancelled", fare: undefined })]).totals, [{ currency: "UZS", total: 25000 }]);
});
test("missing or ambiguous completed fares suppress aggregate instead of reporting partial earnings", () => {
  for (const fare of [undefined, null, { total: 3 }, { currency: "UZS", total: -1 }, { currency: "UZS", total: 3, totalKzt: 3 }]) {
    const result = parse([ride("valid"), ride("legacy", { fare })]);
    assert.equal(result.totals, null); assert.equal(result.rows.length, 2); assert.equal(result.completed, 2);
  }
});
test("safe-integer overflow never becomes a plausible total", () => {
  assert.equal(parse([ride("a", { fare: { currency: "UZS", total: Number.MAX_SAFE_INTEGER } }), ride("b")]).totals, null);
});
test("genuine empty history and zero-price completed work remain distinct", () => {
  assert.deepEqual(parse([]), { rows: [], completed: 0, totals: [] });
  assert.deepEqual(parse([ride("free", { fare: { currency: "UZS", total: 0 } })]).totals, [{ currency: "UZS", total: 0 }]);
});
test("duplicate and malformed snapshots fail closed rather than double-counting or claiming empty", () => {
  for (const value of [null, {}, { orders: null }, { orders: [null] }, { orders: [ride("a"), ride("a")] }, { orders: [ride(1)] }]) {
    assert.throws(() => parseDriverHistory(value, "d"));
  }
  assert.throws(() => parseDriverHistory({ orders: [] }, ""));
});
test("history sorts latest update first, deterministically, without changing the snapshot", () => {
  const rows = [ride("older", { updated_at: "2026-10-29T12:00:00Z" }), ride("newer")];
  assert.deepEqual(parse(rows).rows.map(x => x.order.id), ["newer", "older"]);
  assert.equal(rows[0].id, "older");
});
