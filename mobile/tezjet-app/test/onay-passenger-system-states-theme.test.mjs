import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../app/index.tsx", import.meta.url), "utf8");

function section(start, end) {
  const a = app.indexOf(start);
  const b = app.indexOf(end, a);
  assert.ok(a >= 0 && b > a, "Expected UI section boundaries: " + start);
  return app.slice(a, b);
}

test("passenger server settings and error cards follow Onay dark theme without changing driver mode", () => {
  assert.ok(app.includes('const passengerDarkSystem = Boolean(token && mode === "passenger" && passengerTheme === "dark")'));
  const server = section('{showEndpointSettings ? <View testID="onay-server-settings-panel"', '{visibleError ? <View');
  assert.ok(server.includes('passengerDarkSystem && s.darkPassengerTripCard'));
  assert.ok(server.includes('passengerDarkSystem && s.darkPassengerTripTitle'));
  assert.ok(server.includes('passengerDarkSystem && s.darkPassengerTripMuted'));
  assert.ok(server.includes('passengerDarkSystem && s.legacyInputDark'));
  assert.ok(server.includes('placeholderTextColor={passengerDarkSystem ? onayDark.muted : "#71837a"}'));
  assert.ok(server.includes('dark={passengerDarkSystem}'));
  assert.ok(server.includes('accessibilityRole="alert"'));
});

test("stale data uses a readable alert, retry control and unchanged server refresh actions", () => {
  const card = section('{visibleError ? <View testID="onay-data-error"', '{token && profile && activeRole === "driver"');
  assert.ok(card.includes('accessibilityRole="alert"'));
  assert.ok(card.includes('passengerDarkSystem && s.darkPassengerTripCard'));
  assert.ok(card.includes('passengerDarkSystem && s.darkPassengerTripTitle'));
  assert.ok(card.includes('passengerDarkSystem && s.darkPassengerTripMuted'));
  assert.ok(card.includes('testID="onay-data-error-retry"'));
  assert.ok(card.includes('void refreshOrders(); void refreshAvailability(); setProfileRefresh(value => value + 1);'));
  assert.ok(card.includes('secondary disabled={busy} dark={passengerDarkSystem}'));
});

test("profile recovery retains loading, disconnection and retry without falsely reporting an empty profile", () => {
  const card = section('!profile ? <View testID="onay-profile-unavailable"', ': mode === "driver" ? (');
  assert.ok(card.includes('profileLoading ? "Загружаем профиль…" : "Нет связи с профилем"'));
  assert.ok(card.includes('profileError || "Вход сохранён. Подключись к Onay, чтобы продолжить."'));
  assert.ok(card.includes('passengerDarkSystem && s.darkPassengerTripCard'));
  assert.ok(card.includes('passengerDarkSystem ? onayDark.accent : "#0D735C"'));
  assert.ok(card.includes('testID="onay-profile-retry"'));
  assert.ok(card.includes('onPress={() => setProfileRefresh(value => value + 1)} disabled={profileLoading}'));
  assert.ok(card.includes('secondary dark={passengerDarkSystem}'));
});
