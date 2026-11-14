import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { translateOnay } from "../lib/onay-translations.ts";
import { normalizeOnayContactEmail } from "../lib/onay-contact-email.ts";

function render(language, props) {
  const jsx = (type, props) => ({ type, props });
  const imports = {
    "react/jsx-runtime": { jsx, jsxs: jsx },
    react: { useEffect: () => {}, useRef: value => ({ current: value }), useState: value => [value, () => {}] },
    "react-native": { Pressable: "Pressable", View: "View", Text: "NativeText", StyleSheet: { create: value => value } },
    "./OnayText": { default: "TranslatedText" },
    "./OnayTextInput": { default: "TextInput" },
    "./OnayScreenFrame": { default: "ScreenFrame", onayPalette: () => ({}) },
    "../lib/onay-contact-email": { normalizeOnayContactEmail },
    "../lib/onay-language-context": { useOnayLanguage: () => ({ t: text => translateOnay(text, language) }) },
  };
  const source = readFileSync(new URL("../components/OnayPersonalDetails.tsx", import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const exports = {};
  runInNewContext(code, { exports, require: name => {
    assert.ok(name in imports, "Unexpected component dependency: " + name);
    return imports[name];
  } });
  return exports.default({ theme: "dark", fullName: "", onBack: () => {}, ...props });
}
function elements(node) {
  if (Array.isArray(node)) return node.flatMap(elements);
  return node && typeof node === "object" ? [node, ...elements(node.props?.children)] : [];
}
function byId(tree, id) { return elements(tree).find(node => node.props?.testID === id); }

for (const [language, nameLabel, surnameLabel, phoneLabel, absent, noPhone] of [
  ["ru", "Имя", "Фамилия", "Номер телефона", "Не хранится отдельно", "Не указан"],
  ["kk", "Аты", "Тегі", "Телефон нөмірі", "Бөлек сақталмайды", "Көрсетілмеген"],
  ["uz", "Ism", "Familiya", "Telefon raqami", "Alohida saqlanmagan", "Ko‘rsatilmagan"],
]) {
  test(`${language}: personal detail accessibility translates labels and preserves account values`, () => {
    const tree = render(language, { givenName: "Имя", familyName: "Фамилия", phoneNumber: "+998901234567" });
    for (const [id, label, value] of [["name", nameLabel, "Имя"], ["surname", surnameLabel, "Фамилия"], ["phone", phoneLabel, "+998901234567"]]) {
      const row = byId(tree, "onay-profile-personal-" + id);
      assert.equal(row.props.accessibilityLabel, label + ": " + value);
      assert.equal(row.props.children.type, "NativeText", "Account values must not pass through dictionary lookup");
      assert.equal(row.props.children.props.children, value);
    }
  });
  test(`${language}: missing values and full-name explanation translate without changing a supplied full name`, () => {
    const fullName = "Имя";
    const tree = render(language, { fullName });
    assert.equal(byId(tree, "onay-profile-personal-name").props.accessibilityLabel, nameLabel + ": " + absent);
    assert.equal(byId(tree, "onay-profile-personal-phone").props.accessibilityLabel, phoneLabel + ": " + noPhone);
    const note = byId(tree, "onay-personal-name-storage-note").props.children;
    assert.ok(note.includes(fullName));
    assert.equal(note, `${translateOnay("Имя и фамилия не сохранены отдельно. Полное ФИО в аккаунте:", language)} ${fullName}. ${translateOnay("Мы не разделяем его автоматически, чтобы не исказить данные.", language)}`);
    if (language !== "ru") assert.ok(!note.includes("Мы не разделяем"));
    const emptyNote = byId(render(language, {}), "onay-personal-name-storage-note").props.children;
    assert.ok(emptyNote.includes(translateOnay("Не указано", language)));
  });
}
