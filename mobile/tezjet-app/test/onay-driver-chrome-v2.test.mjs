import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const app = read('../app/index.tsx'), shell = read('../components/OnayDriverShell.tsx'), profile = read('../components/OnayDriverProfile.tsx');
test('driver chrome uses reference branding and five real theme-aware pages without the previous hero', () => {
 assert.ok(app.includes('return <OnayDriverShell'));
 assert.ok(!app.includes('ТВОЙ ГОРОД. ТВОЙ МАРШРУТ.'));
 assert.ok(shell.includes('testID="onay-driver-confirmed-logo" source={require("../assets/onay-original-logo.png")}'));
 for (const id of ['line','queue','chats','history','profile']) assert.ok(shell.includes('id: "'+id+'"'));
 for (const color of ['background','card','cardRaised','border','text','muted','accent']) assert.ok((app+shell+profile).includes('c.'+color));
 assert.ok(shell.includes('importantForAccessibility={active === tab.id ? "auto" : "no-hide-descendants"}'));
 assert.ok(shell.includes('pointerEvents={active === tab.id ? "auto" : "none"}'));
});
test('role switch and logout retain actual handlers and cannot bypass live approval or pending work', () => {
 assert.ok(app.includes('onPassenger={() => { void switchMode("passenger"); }}'));
 assert.ok(app.includes('busy={busy || profileLoading}'));
 assert.ok(profile.includes('onPress={onLogout}'));
 assert.ok(app.includes('profile.driver_approval_status !== "approved" ?'));
 assert.ok(app.includes('testID="driver-queue-join" onPress={joinQueue} disabled={busy || !!incomingOrder || !canJoinQueue}'));
 assert.ok(app.includes('disabled={busy || profile.driver_approval_status !== "approved" || queueMembership === "unknown" || !!incomingOrder || activeDriverOrders.length > 0}'));
});
