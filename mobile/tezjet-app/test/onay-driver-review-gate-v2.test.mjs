import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../app/index.tsx", import.meta.url), "utf8");
const from = app.indexOf('profile.driver_approval_status !== "approved" ? <View');
const to = app.indexOf('\n      : <>\n        <DriverRoutePicker', from);
const gate = app.slice(from, to);

test("driver review and blocked gate uses Onay V2 readable tokens", () => {
  assert.ok(from > 0 && to > from, "Driver review gate must exist");
  assert.ok(gate.includes('testID="onay-driver-review-gate"'));
  assert.ok(gate.includes('s.driverReviewCard'));
  assert.ok(gate.includes('s.driverReviewTitle'));
  assert.ok(gate.includes('s.driverReviewDescription'));
  assert.ok(app.includes('driverReviewCard:{backgroundColor:onayDark.card,borderColor:onayDark.border}'));
  assert.ok(app.includes('driverReviewTitle:{color:onayDark.text}'));
  assert.ok(app.includes('driverReviewDescription:{color:onayDark.muted}'));
  assert.ok(gate.includes('accessibilityRole="header"'));
});

test("driver may not accept orders or join queue without server approval", () => {
  assert.ok(gate.includes('profile.driver_approval_status !== "approved"'));
  assert.ok(gate.includes('profile.driver_approval_status === "blocked" ? "Профиль заблокирован"'));
  assert.ok(gate.includes('profile.driver_approval_status === "rejected" ? "Профиль отклонён"'));
  assert.ok(gate.includes('"Профиль на проверке"'));
  assert.ok(gate.includes('Изменение автомобиля не снимает блокировку.'));
  assert.ok(gate.includes('До этого нельзя вставать в очередь или принимать заказы.'));
  assert.ok(gate.includes('testID="onay-driver-review-refresh" onPress={refreshProfile} secondary disabled={busy} dark'));
  assert.ok(!gate.includes('onPress={joinQueue}'));
  assert.ok(!gate.includes('onPress={acceptOrder}'));
  assert.ok(app.includes('activeRole !== "driver" ?'));
  assert.ok(app.includes('<DriverRoutePicker'));
});
