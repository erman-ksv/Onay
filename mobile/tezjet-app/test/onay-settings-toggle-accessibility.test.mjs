import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const home = readFileSync(new URL("../components/OnayPassengerHome.tsx", import.meta.url), "utf8");

test("home settings toggle announces whether it opens or closes the menu", () => {
  const start = home.indexOf('<Pressable testID="onay-home-menu-open"');
  const end = home.indexOf('</Pressable>', start);
  const toggle = home.slice(start, end);
  assert.ok(start > 0 && end > start, "Onay home settings toggle must exist");
  assert.ok(toggle.includes('accessibilityRole="button"'));
  assert.ok(toggle.includes('accessibilityLabel={menuOpen ? "Закрыть настройки" : "Открыть настройки"}'));
  assert.ok(toggle.includes('accessibilityState={{ expanded: menuOpen }}'));
  assert.ok(toggle.includes('onPress={() => setMenuOpen(value => !value)}'));
});

test("screen reader label change preserves the existing settings content and About navigation", () => {
  assert.ok(home.includes('const [menuOpen, setMenuOpen] = useState(false)'));
  assert.ok(home.includes('{menuOpen ? <View testID="onay-home-settings-menu"'));
  assert.ok(home.includes('Способ оплаты'));
  assert.ok(home.includes('Наличными'));
  assert.ok(home.includes('testID={"onay-home-theme-" + value}'));
  assert.ok(home.includes('testID="onay-home-about" onPress={() => setAboutOpen(true)}'));
  assert.ok(home.includes('setAboutOpen(false); setMenuOpen(false);'));
  assert.ok(home.includes('onPress={() => onChoose("city")}'));
  assert.ok(home.includes('onPress={() => onChoose("village")}'));
  assert.ok(home.includes('onPress={() => onChoose("address")}'));
});
