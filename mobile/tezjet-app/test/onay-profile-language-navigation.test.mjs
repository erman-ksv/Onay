import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ONAY_LANGUAGES, translateOnay } from "../lib/onay-translations.ts";
const read = file => readFileSync(new URL(file, import.meta.url), "utf8");
test("three requested languages localize passenger and driver labels without changing unknown API data", () => {
 assert.deepEqual(ONAY_LANGUAGES.map(x => x.code), ["kk", "ru", "uz"]);
 for (const key of ["Главная", "Поездки", "История поездок", "Язык приложения", "Режим водителя", "Автомобиль", "Завершить поездку"]) {
  assert.equal(translateOnay(key, "ru"), key);
  assert.notEqual(translateOnay(key, "kk"), key);
  assert.notEqual(translateOnay(key, "uz"), key);
 }
 for (const language of ["ru", "kk", "uz"]) for (const value of ["Gazalkent", "+998901234567", "12 000 UZS", "onay-demo-ride", "Алия", ""]) assert.equal(translateOnay(value, language), value);
 assert.equal(translateOnay(" Главная ", "kk"), " Басты бет ");
});
test("history returns to its origin in both real and offline trees, including Android Back", () => {
 const app=read("../app/index.tsx"), demo=read("../components/OnayDemoApp.tsx");
 assert.match(app,/historyReturnTab.current = passengerTab/);
 assert.match(app,/setPassengerTab\(historyReturnTab.current\)/);
 assert.match(app,/onShowActive=\{closePassengerHistory\}/);
 assert.match(app,/if \(passengerTab === "trips" && tripsHistoryOpen\) \{ closePassengerHistory\(\); return true;/);
 assert.match(demo,/historyReturnTab.current = tab/);
 assert.match(demo,/setTab\(historyReturnTab.current\)/);
 assert.match(demo,/onShowActive=\{closeHistory\}/);
 assert.match(demo,/if \(tab === "trips" && historyOpen\) \{ closeHistory\(\); return true;/);
});
test("language survives restart independently of auth, stale hydration cannot overwrite a new selection", () => {
 const source=read("../lib/onay-language-context.tsx");
 assert.match(source,/onay_language_v1/);
 assert.match(source,/AsyncStorage.getItem\(LANGUAGE_KEY\)/);
 assert.match(source,/AsyncStorage.setItem\(LANGUAGE_KEY, value\)/);
 assert.match(source,/active && !changed.current/);
 assert.match(source,/value === "ru" \|\| value === "kk" \|\| value === "uz"/);
 assert.doesNotMatch(source,/fetch\(|TOKEN|socket|\/api\//);
 for (const file of ["../components/OnayPassengerProfile.tsx", "../components/OnayDriverProfile.tsx"]) {
  assert.match(read(file),/OnayInlineLanguage/);
  assert.doesNotMatch(read(file),/OnayLanguageSettings/);
 }
 const inline = read("../components/OnayInlineLanguage.tsx");
 assert.match(inline, /code: "kk", caption: "KZ"/);
 assert.match(inline, /changeLanguage/);
 assert.match(inline, /accessibilityRole="radiogroup"/);
});
