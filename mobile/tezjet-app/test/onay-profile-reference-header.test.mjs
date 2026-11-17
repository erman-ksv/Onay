import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const profile = readFileSync(new URL("../components/OnayPassengerProfile.tsx", import.meta.url), "utf8");
const identityStart = profile.indexOf('<View style={s.identity}>');
const groupStart = profile.indexOf('<View style={[s.group, { backgroundColor: surface }]}>', identityStart);
const header = profile.slice(identityStart, groupStart);

test("Onay V2 profile puts the theme switch beside authenticated identity, not inside personal settings", () => {
  assert.ok(identityStart >= 0 && groupStart > identityStart);
  assert.ok(header.includes('testID="onay-profile-header-theme"'));
  assert.ok(header.includes('accessibilityLabel="Режим света"'));
  assert.ok(header.includes('testID={"onay-profile-theme-" + value}'));
  assert.ok(header.includes('accessibilityState={{ selected: theme === value }}'));
  assert.ok(header.includes('onPress={() => onThemeChange(value)}'));
  assert.ok(profile.includes('identity: { flexDirection: "row", alignItems: "center", paddingHorizontal: 0, paddingVertical: 4'));
  assert.ok(profile.includes('linkRow: { minHeight: 58'));
});

test("reference-based geometry keeps real account data, navigation, and original three content blocks", () => {
  assert.ok(header.includes('fullName || "Пассажир Onay"'));
  assert.ok(header.includes('phoneNumber || "Аккаунт пассажира"'));
  assert.ok(profile.includes('onayProfileInitial(fullName)'));
  for (const action of [
    'row("history", "История поездок", onHistory)',
    'row("driver", "Режим водителя", () => setDriverModeOpen(true))',
    'row("support", "Поддержка", () => setSupportOpen(true))',
    'row("about", "О приложении", () => setAboutOpen(true))',
    'testID="onay-profile-logout" onPress={onLogout}'
  ]) assert.ok(profile.includes(action), "Action missing: " + action);
  assert.equal((profile.match(/<View style=\{\[s\.group, \{ backgroundColor: surface \}\]\}>/g) ?? []).length, 3);
  assert.ok(profile.includes('Onay · Версия {APP_VERSION}'));
  assert.ok(!profile.includes("Поиск водителя"));
});
