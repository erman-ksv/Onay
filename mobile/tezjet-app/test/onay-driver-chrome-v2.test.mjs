import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../app/index.tsx", import.meta.url), "utf8");
const headerStart = app.indexOf('{!(token && profile && activeRole === "passenger" && mode === "passenger") ? <>');
const headerEnd = app.indexOf('{showEndpointSettings ? <View', headerStart);
const chrome = app.slice(headerStart, headerEnd);

test("driver chrome uses confirmed Onay logo and consistent dark colors", () => {
  assert.ok(headerStart > 0 && headerEnd > headerStart);
  assert.ok(app.includes('const driverChrome = Boolean(token && mode === "driver")'));
  assert.ok(app.includes('driverChrome ? onayDark.background : "#F3F6F4"'));
  assert.ok(app.includes('driverChrome && s.driverScreen'));
  assert.ok(chrome.includes('testID="onay-driver-confirmed-logo" source={require("../assets/onay-confirmed-logo.jpg")}'));
  for (const style of ["driverHeader", "driverBrand", "driverTag", "driverLogout", "driverHero", "driverKicker", "driverHeroTitle", "driverHeroText"]) {
    assert.ok(chrome.includes("s." + style), "Driver UI not using theme: " + style);
  }
  for (const palette of ["background", "card", "border", "text", "muted", "accent"]) {
    assert.ok(app.includes("onayDark." + palette), "Missing palette: " + palette);
  }
  assert.ok(app.includes('driverFooter:{color:onayDark.muted}'));
});

test("role switch still uses existing handler and cannot bypass busy/profile lock", () => {
  assert.ok(chrome.includes('testID="onay-role-switch"'));
  assert.ok(chrome.includes('testID="onay-switch-to-passenger" onPress={() => switchMode("passenger")} disabled={busy || profileLoading} secondary={mode !== "passenger"} dark={driverChrome}'));
  assert.ok(chrome.includes('testID="onay-switch-to-driver" onPress={() => switchMode("driver")} disabled={busy || profileLoading} secondary={mode !== "driver"} dark={driverChrome}'));
  assert.ok(chrome.includes('onPress={logout} disabled={busy} accessibilityRole="button" accessibilityLabel="Выйти из аккаунта"'));
  assert.ok(app.includes('accessibilityRole="button" accessibilityState={{ disabled }}'));
  assert.ok(app.includes('profile.driver_approval_status !== "approved" ?'));
  assert.ok(app.includes('testID="driver-queue-join" onPress={joinQueue} disabled={busy || !!incomingOrder || !canJoinQueue}'));
});
