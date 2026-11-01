import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parsePassengerHistory } from "../lib/passenger-history.ts";

const source = readFileSync(new URL("../components/PassengerHistory.tsx", import.meta.url), "utf8");

test("Onay V2 empty history appears only after a confirmed zero-result server response", () => {
  assert.deepEqual(parsePassengerHistory({ orders: [] }, "passenger-1"), []);
  assert.throws(() => parsePassengerHistory({ orders: null }, "passenger-1"));
  const dataBranch = source.indexOf('{rows ? <View testID="passenger-history-results">');
  const emptyBranch = source.indexOf('{!rows.length ? <View testID="passenger-history-empty"');
  const closed = source.indexOf('{rows.slice(0, limit).map(', emptyBranch);
  assert.ok(dataBranch >= 0 && emptyBranch > dataBranch && closed > emptyBranch);
  assert.match(source, /setRows\(null\); setLoading\(true\); setError\("…"\)/);
  assert.match(source, /if \(generation\.current === ticket && !controller\.signal\.aborted\) setRows\(value\)/);
  assert.match(source, /if \(generation\.current === ticket\) setError\(/);
});

test("The original Onay V2 empty-copy is accessible in both themes and history actions remain", () => {
  assert.match(source, /testID="passenger-history-empty-title"/);
  assert.match(source, /Поездок пока нет/);
  assert.match(source, /Здесь появятся завершённые и отменённые поездки/);
  assert.match(source, /!light && s\.darkEmpty/);
  assert.match(source, /!light && s\.darkHeading/);
  assert.match(source, /!light && s\.darkMuted/);
  assert.match(source, /testID="passenger-history-refresh"/);
  assert.match(source, /testID="passenger-history-toggle"/);
});
