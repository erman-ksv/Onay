import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { translateOnay } from "../lib/onay-translations.ts";
import { ONAY_PASSENGER_TABS } from "../lib/onay-passenger-tabs.ts";
import { onayTabWidths } from "../lib/onay-tab-layout.ts";
import { onayDark } from "../lib/onay-auth-ui.ts";

// Execute the actual components with native primitives and hooks stubbed. This
// checks the props sent to native accessibility, without a browser or emulator.
function component(file, language) {
  const native = Object.fromEntries(["Image", "Pressable", "View", "KeyboardAvoidingView", "ScrollView"].map(name => [name, name]));
  Object.assign(native, { StyleSheet: { create: value => value }, Platform: { OS: "web" }, useWindowDimensions: () => ({ width: 390 }) });
  const jsx = (type, props) => ({ type, props });
  const imports = {
    "react/jsx-runtime": { jsx, jsxs: jsx },
    react: { useEffect: () => {} },
    "react-native": native,
    "react-native-safe-area-context": { useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) },
    "expo-status-bar": { StatusBar: "StatusBar" },
    "./OnayText": { default: "Text" },
    "../lib/onay-theme-context": { OnayThemeContext: { Provider: "ThemeProvider" } },
    "../lib/onay-auth-ui": { onayDark },
    "../lib/onay-passenger-tabs": { ONAY_PASSENGER_TABS },
    "../lib/onay-tab-layout": { onayTabWidths },
    "../lib/onay-language-context": { useOnayLanguage: () => ({ t: text => translateOnay(text, language) }) },
  };
  const output = ts.transpileModule(readFileSync(new URL("../components/" + file, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const exports = {};
  runInNewContext(output, { exports, require: name => {
    if (name.endsWith(".png")) return name;
    assert.ok(name in imports, "Unexpected component dependency: " + name);
    return imports[name];
  } });
  return exports.default;
}
function elements(node) {
  if (Array.isArray(node)) return node.flatMap(elements);
  return node && typeof node === "object" ? [node, ...elements(node.props?.children)] : [];
}

for (const [language, tabNames, back] of [
  ["ru", ["Главная", "Поездки", "Чаты", "Профиль"], "Назад"],
  ["kk", ["Басты бет", "Сапарлар", "Чаттар", "Профиль"], "Артқа"],
  ["uz", ["Bosh sahifa", "Safarlar", "Chatlar", "Profil"], "Orqaga"],
]) {
  test(`${language}: native tabs announce the selected language and preserve navigation`, () => {
    const TabBar = component("OnayPassengerTabBar.tsx", language);
    const selected = [];
    const tabs = elements(TabBar({ active: "home", onSelect: id => selected.push(id) }))
      .filter(node => node.props?.accessibilityRole === "tab");
    assert.deepEqual(tabs.map(node => node.props.accessibilityLabel), tabNames);
    tabs.forEach(node => node.props.onPress());
    assert.deepEqual(selected, ["home", "trips", "chats", "profile"]);
    assert.deepEqual(tabs.map(node => node.props.accessibilityState.selected), [true, false, false, false]);

  });
  test(`${language}: native Back announces the selected language and preserves navigation`, () => {
    const Frame = component("OnayScreenFrame.tsx", language);
    let returned = false;
    const button = elements(Frame({ title: "Личные данные", onBack: () => { returned = true; } }))
      .find(node => node.props?.testID === "onay-screen-back");
    assert.equal(button.props.accessibilityLabel, back);
    assert.equal(button.props.accessibilityRole, "button");
    button.props.onPress();
    assert.equal(returned, true);
  });
}
