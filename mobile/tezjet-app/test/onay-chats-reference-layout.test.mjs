import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const chats = readFileSync(new URL("../components/OnayPassengerChatsEmpty.tsx", import.meta.url), "utf8");
const app = readFileSync(new URL("../app/index.tsx", import.meta.url), "utf8");

test("empty chats layout uses the reference V2 title, spacing, icon and typography", () => {
  assert.ok(chats.includes('heading: { fontSize: 30, fontWeight: "700"'));
  assert.ok(chats.includes('empty: { marginTop: 90'));
  assert.ok(chats.includes('iconCircle: { width: 72, height: 72, borderRadius: 36'));
  assert.ok(chats.includes('bubble: { width: 42, height: 28, borderWidth: 2'));
  assert.ok(chats.includes('bubbleTail: {'));
  assert.ok(chats.includes('title: { fontSize: 17, fontWeight: "600"'));
  assert.ok(chats.includes('explanation: { fontSize: 14, lineHeight: 21'));
  assert.ok(!chats.includes('bubbleDots'), "Reference uses an outline icon, not dot glyphs");
});

test("reference chat empty state preserves live limitation, navigation and theme", () => {
  assert.ok(chats.includes('Переписка с водителем пока недоступна.'));
  assert.ok(chats.includes('Чаты с пассажирами пока недоступны.'));
  assert.ok(chats.includes('showHeading = true'));
  assert.ok(app.includes('role="driver" showHeading={false}'));
  assert.ok(chats.includes('testID="onay-chats-empty-title"'));
  assert.ok(chats.includes('light && styles.lightPage'));
  assert.ok(chats.includes('light && styles.lightHeading'));
  assert.ok(chats.includes('light && styles.lightMuted'));
  assert.ok(app.includes('testID="onay-passenger-chats"'));
  assert.ok(app.includes('<OnayPassengerChatsEmpty theme={passengerTheme} />'));
  assert.ok(!chats.includes("socket.emit(") && !chats.includes("fetch("), "UI must not simulate live conversations");
});
