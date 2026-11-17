import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../app/index.tsx", import.meta.url), "utf8");
const begin = app.indexOf("function Stepper(");
const end = app.indexOf("export default function Home()", begin);
const counter = app.slice(begin, end);

test("shared seat stepper announces both accessible actions and current seat count", () => {
  assert.ok(begin > 0 && end > begin);
  assert.ok(counter.includes('accessibilityRole="button" accessibilityLabel="Уменьшить количество мест"'));
  assert.ok(counter.includes('accessibilityRole="button" accessibilityLabel="Увеличить количество мест"'));
  assert.ok(counter.includes('accessibilityLabel={\`Выбрано мест: \${value}\`}'));
  assert.equal((counter.match(/accessibilityRole="button"/g) ?? []).length, 2);
});

test("screen-reader disabled state matches the actual minimum and maximum seat guards", () => {
  assert.ok(counter.includes('accessibilityState={{ disabled: disabled || value <= min }}'));
  assert.ok(counter.includes('accessibilityState={{ disabled: disabled || value >= max }}'));
  assert.ok(counter.includes('disabled={disabled || value <= min}'));
  assert.ok(counter.includes('disabled={disabled || value >= max}'));
  assert.ok(counter.includes('onPress={() => onChange(Math.max(min, value - 1))}'));
  assert.ok(counter.includes('onPress={() => onChange(Math.min(max, value + 1))}'));
  assert.ok(counter.includes('min = 1, max = 8, disabled = false, dark = false'));
});

test("passenger and driver keep their real seat state and booking/queue restrictions", () => {
  assert.ok(app.includes('<Stepper value={seats} onChange={setSeats} dark={passengerTheme === "dark"} />'));
  assert.ok(app.includes('<Stepper value={driverSeats} max={maxDriverSeats} onChange={setDriverSeats} disabled={busy || queueMembership !== "absent" || !!incomingOrder || activeDriverOrders.length > 0} dark />'));
  assert.ok(app.includes('onPress={order} disabled={busy || !fareFresh || !canOrder || passengerHasActiveOrder || !bookingGate.canSubmit()}'));
  assert.ok(app.includes('testID="driver-queue-join" onPress={joinQueue} disabled={busy || !!incomingOrder || !canJoinQueue} dark />'));
});
