import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read=path=>readFileSync(new URL(path,import.meta.url),'utf8');
const app=read('../app/index.tsx'),server=read('../components/OnayServerSettings.tsx'),frame=read('../components/OnayScreenFrame.tsx');
test('connection settings are an independent V2 page with theme, explicit save and safe back',()=>{
 assert.ok(app.includes('entryScreen === "connection"'));
 assert.ok(app.includes('onSave={() => { void saveEndpoint(); }}'));
 assert.ok(server.includes('testID="onay-server-settings-panel"'));
 assert.ok(server.includes('const c = onayPalette(theme)'));
 assert.ok(server.includes('disabled={busy || !value.trim()}'));
 assert.ok(server.includes('editable={!busy}'));
 assert.ok(server.includes('accessibilityRole="alert"'));
 assert.ok(frame.includes('BackHandler.addEventListener("hardwareBackPress"'));
});
test('stale passenger data keeps readable alert and unchanged real refresh actions',()=>{
 const from=app.indexOf('{visibleError ? <View testID="onay-data-error"');const to=app.indexOf('<Modal visible={bookingPage',from);assert.ok(from>0&&to>from);const card=app.slice(from,to);
 for(const value of ['accessibilityRole="alert"','passengerDarkSystem && s.darkPassengerTripCard','testID="onay-data-error-retry"','void refreshOrders(); void refreshAvailability(); setProfileRefresh(value => value + 1);','disabled={busy}'])assert.ok(card.includes(value));
});
test('profile recovery remains distinct from empty and never renders the previous shell',()=>{
 const from=app.indexOf('if (token && !profile) return <OnayScreenFrame');const to=app.indexOf('// Presentation only;',from);assert.ok(from>0&&to>from);const card=app.slice(from,to);
 for(const value of ['profileLoading ? "Загружаем профиль…" : "Нет связи с профилем"','testID="onay-profile-unavailable"','profileError ||','<ActivityIndicator','testID="onay-profile-retry"','onPress={() => setProfileRefresh(value => value + 1)}','disabled={busy || profileLoading}','onPress={logout}'])assert.ok(card.includes(value));
 assert.ok(!app.includes('ТВОЙ ГОРОД. ТВОЙ МАРШРУТ.'));
});
