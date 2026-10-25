import assert from "node:assert/strict";
import { test } from "node:test";
import { parseServerFareMoney, formatFareMoney } from "../lib/fare-money.ts";
import { parsePassengerRouteAvailability } from "../lib/passenger-route-orders.ts";

const quote = fare => ({ available: true, eligible_driver_count: 2, fare });

test("old KZT server totals retain their amount and currency without conversion", () => {
  assert.deepEqual(parseServerFareMoney({ currency: "KZT", totalKzt: 4000 }), { currency: "KZT", total: 4000 });
  assert.deepEqual(parseServerFareMoney({ currency: "KZT", totalKzt: 0 }), { currency: "KZT", total: 0 });
});

test("canonical UZS totals use exactly the server total and never a client exchange rate", () => {
  assert.deepEqual(parseServerFareMoney({ currency: "UZS", total: 25000 }), { currency: "UZS", total: 25000 });
  assert.deepEqual(parseServerFareMoney({ currency: "UZS", total: 0 }), { currency: "UZS", total: 0 });
});

test("canonical KZT can coexist with an identical legacy field during API migration", () => {
  assert.deepEqual(parseServerFareMoney({ currency: "KZT", total: 4000 }), { currency: "KZT", total: 4000 });
  assert.deepEqual(parseServerFareMoney({ currency: "KZT", total: 4000, totalKzt: 4000 }), { currency: "KZT", total: 4000 });
});

test("UZS never accepts a KZT-only amount or an ambiguous mixed money contract", () => {
  for (const value of [
    { currency: "UZS", totalKzt: 25000 },
    { currency: "UZS", total: 25000, totalKzt: 25000 },
    { currency: "UZS", total: 25000, totalKzt: 4000 },
  ]) assert.throws(() => parseServerFareMoney(value));
});

test("negative fractional overflow nonnumeric and missing money fail closed for both currencies", () => {
  for (const currency of ["KZT", "UZS"]) {
    for (const total of [-1, 0.1, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, "25000", null, undefined]) {
      assert.throws(() => parseServerFareMoney({ currency, total }));
    }
    assert.throws(() => parseServerFareMoney({ currency }));
    assert.deepEqual(parseServerFareMoney({ currency, total: Number.MAX_SAFE_INTEGER }), { currency, total: Number.MAX_SAFE_INTEGER });
  }
  for (const totalKzt of [-1, 0.1, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, "4000", null, undefined]) {
    assert.throws(() => parseServerFareMoney({ currency: "KZT", totalKzt }));
  }
});

test("conflicting or malformed KZT aliases cannot hide behind a valid canonical total", () => {
  for (const totalKzt of [3999, 4001, -1, "4000", null, undefined]) {
    assert.throws(() => parseServerFareMoney({ currency: "KZT", total: 4000, totalKzt }));
  }
  assert.throws(() => parseServerFareMoney({ currency: "KZT", total: undefined, totalKzt: 4000 }));
});

test("unknown and missing currencies never inherit the Uzbekistan market by assumption", () => {
  for (const currency of ["USD", "uzs", "KGS", "", undefined, null, 123]) {
    assert.throws(() => parseServerFareMoney({ currency, total: 25000, totalKzt: 4000 }));
  }
  for (const body of [null, undefined, [], "25000", 25000]) assert.throws(() => parseServerFareMoney(body));
});

test("configured availability accepts canonical UZS without a misleading priceKzt alias", () => {
  const result = parsePassengerRouteAvailability(quote({ currency: "UZS", total: 25000 }));
  assert.deepEqual(result, { available: true, eligibleDriverCount: 2, price: 25000, currency: "UZS" });
  assert.equal(Object.hasOwn(result, "priceKzt"), false);
});

test("configured legacy KZT availability remains compatible and also exposes neutral price", () => {
  const result = parsePassengerRouteAvailability(quote({ currency: "KZT", totalKzt: 4000 }));
  assert.deepEqual(result, { available: true, eligibleDriverCount: 2, price: 4000, priceKzt: 4000, currency: "KZT" });
  assert.equal(parsePassengerRouteAvailability(quote({ currency: "KZT", total: 4000, totalKzt: 4000 })).priceKzt, 4000);
});

test("currency support does not relax eligibility validation or accept ambiguous UZS quotes", () => {
  for (const body of [
    quote({ currency: "UZS", totalKzt: 25000 }),
    quote({ currency: "UZS", total: -1 }),
    quote({ currency: "USD", total: 25000 }),
    { ...quote({ currency: "UZS", total: 25000 }), eligible_driver_count: 0 },
    { ...quote({ currency: "UZS", total: 25000 }), available: "true" },
    { ...quote({ currency: "UZS", total: 25000 }), eligible_driver_count: 1.5 },
  ]) assert.throws(() => parsePassengerRouteAvailability(body));
  assert.deepEqual(parsePassengerRouteAvailability({ available: false, eligible_driver_count: 0, fare: { currency: "UZS", total: 25000 } }),
    { available: false, eligibleDriverCount: 0, price: 25000, currency: "UZS" });
});

test("formatting uses server currency for sum or tenge and preserves the integer amount", () => {
  assert.equal(formatFareMoney({ currency: "UZS", total: 25000 }).replaceAll(/\s/g, " "), "25 000 сум");
  assert.equal(formatFareMoney({ currency: "KZT", total: 4000 }).replaceAll(/\s/g, " "), "4 000 ₸");
  assert.throws(() => formatFareMoney({ currency: "USD", total: 25000 }));
  assert.throws(() => formatFareMoney({ currency: "UZS", total: -1 }));
});
