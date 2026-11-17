import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const chat = readFileSync(new URL("../components/OnayPassengerChatsEmpty.tsx", import.meta.url), "utf8");
const app = readFileSync(new URL("../app/index.tsx", import.meta.url), "utf8");

test("passenger chats match the original Onay V2 empty list layout", () => {
  assert.match(chat, /testID="onay-chats-empty-state"/);
  assert.match(chat, /testID="onay-chats-empty-title"/);
  assert.match(chat, /Чатов пока нет/);
  assert.match(chat, /styles\.empty/);
  assert.match(chat, /light && styles\.lightPage/);
  assert.match(chat, /light && styles\.lightHeading/);
});

test("unimplemented chat messaging does not invent conversations or impersonate drivers", () => {
  assert.match(chat, /Переписка с водителем пока недоступна/);
  assert.doesNotMatch(chat, /fetch\(|request\(|socket\.emit|TextInput|Отправить сообщение/);
  assert.doesNotMatch(chat, /Чат с водителем появится после подтверждения заказа/);
});

test("existing passenger tab navigation targets the themed empty chat section", () => {
  assert.match(app, /chats=\{<>/);
  assert.match(app, /testID="onay-passenger-chats"/);
  assert.match(app, /<OnayPassengerChatsEmpty theme=\{passengerTheme\} \/>/);
  assert.match(app, /<PassengerHistory /);
  assert.match(app, /<OnayPassengerProfile/);
  assert.match(app, /bookingGate=\{bookingGate\}/);
});
