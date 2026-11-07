import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { driverModeStatus, hasCompleteDriverVehicle, driverModeReadyForQueue } from "../lib/onay-driver-mode-status.ts";
const read = path => readFileSync(new URL(path, import.meta.url), "utf8");

const vehicle = { make: "Chevrolet", model: "Cobalt", plate_number: "01 A 123 BC", seat_capacity: 4 };

test("server approval status is not invented and a missing application stays unfilled", () => {
 assert.equal(driverModeStatus(undefined, null), "unfilled");
 assert.equal(driverModeStatus(undefined, vehicle), "unknown");
 for (const state of ["pending", "approved", "rejected", "blocked"]) {
   assert.equal(driverModeStatus(state, vehicle), state);
 }
 assert.equal(driverModeStatus("approved", null), "approved", "Missing car is a separate blocker, not an approval change");
 assert.equal(hasCompleteDriverVehicle(null), false);
 assert.equal(hasCompleteDriverVehicle({ ...vehicle, plate_number: "" }), false);
 assert.equal(hasCompleteDriverVehicle(vehicle), true);
});

test("queue readiness requires an approved server status, complete vehicle, route and existing queue gate", () => {
 for (const state of [undefined, "pending", "rejected", "blocked", "approved-by-demo"]) {
   assert.equal(driverModeReadyForQueue(state, vehicle, true, true), false);
 }
 assert.equal(driverModeReadyForQueue("approved", null, true, true), false);
 assert.equal(driverModeReadyForQueue("approved", vehicle, false, true), false);
 assert.equal(driverModeReadyForQueue("approved", vehicle, true, false), false);
 assert.equal(driverModeReadyForQueue("approved", vehicle, true, true), true);
});

test("passenger driver row opens informational modal before any role-switch request", () => {
 const profile = read("../components/OnayPassengerProfile.tsx");
 const ui = read("../components/OnayDriverModeOverview.tsx");
 assert.match(profile, /row\("driver", "Режим водителя", \(\) => setDriverModeOpen\(true\)\)/);
 assert.match(profile, /if \(driverModeOpen\) return <Modal visible/);
 assert.match(profile, /onRequestClose=\{\(\) => setDriverModeOpen\(false\)\}/);
 assert.match(profile, /onBack=\{\(\) => setDriverModeOpen\(false\)\}/);
 assert.match(profile, /if \(driverModeOpen\) \{ setDriverModeOpen\(false\); return true; \}/);
 assert.match(profile, /onOpenDriver=\{\(\) => \{ setDriverModeOpen\(false\); onDriver\(\); \}\}/);
 assert.match(ui, /testID="onay-driver-mode-overview"/);
 assert.match(ui, /testID="onay-driver-mode-status-card"/);
 assert.match(ui, /testID="onay-driver-mode-vehicle"/);
 assert.match(ui, /testID="onay-driver-mode-route"/);
 assert.match(ui, /accessibilityState=\{\{ checked: onLine, disabled: true \}\}/);
 assert.doesNotMatch(ui, /joinQueue\(|socket\.emit\(|fetch\(|request\(/);
});

test("demo status selector and top role-switcher stay separate and never grant approval", () => {
 const demo = read("../components/OnayDemoApp.tsx");
 const overview = read("../components/OnayDriverModeOverview.tsx");
 assert.match(demo, /onDriver=\{\(\) => role\("driver"\)\}/);
 assert.match(demo, /testID=\{"onay-demo-role-" \+ value\}/);
 assert.match(overview, /demoMode \? demoStatus : driverModeStatus\(approval, vehicle\)/);
 assert.match(overview, /const ready = !demoMode && driverModeReadyForQueue/);
 assert.match(overview, /const onLine = !demoMode && approval === "approved" && enrolled/);
 assert.match(overview, /testID=\{"onay-driver-mode-demo-" \+ value\}/);
 assert.match(overview, /demoMode\s*\?\s*<Text/);
 const idx=overview.indexOf('testID="onay-driver-mode-enter"');
 assert.ok(idx>0);
 assert.match(overview.slice(idx-100,idx+210), /onPress=\{onOpenDriver\}/);
 assert.doesNotMatch(demo, /\/api\/|socket\.io|request\(|fetch\(/);
});

test("driver chats show one heading from DriverShell and no passenger-specific explanation", () => {
 const shell = read("../components/OnayDriverShell.tsx");
 const chats = read("../components/OnayPassengerChatsEmpty.tsx");
 const demo = read("../components/OnayDemoApp.tsx");
 const live = read("../app/index.tsx");
 assert.match(shell, /tabs\.find\(t => t\.id === active\)\?\.label/);
 assert.match(chats, /showHeading \? <Text testID="onay-chats-inner-heading"/);
 assert.match(chats, /role === "driver"/);
 assert.match(chats, /Чаты с пассажирами пока недоступны/);
 assert.match(demo, /chats: <OnayPassengerChatsEmpty theme=\{theme\} role="driver" showHeading=\{false\}\/>/);
 assert.match(live, /chats: <OnayPassengerChatsEmpty theme=\{passengerTheme\} role="driver" showHeading=\{false\}\/>/);
 assert.match(live, /<OnayPassengerChatsEmpty theme=\{passengerTheme\} \/>/);
 assert.doesNotMatch(chats, /fetch\(|request\(|socket\.emit\(|TextInput/);
});

test("live driver queue and API switch remain server-backed and protected", () => {
 const live=read("../app/index.tsx");
 assert.match(live, /driverApprovalStatus=\{profile.driver_approval_status\}/);
 assert.match(live, /driverVehicle=\{profile.driver_vehicle\}/);
 assert.match(live, /driverRouteName=\{driverQueueContext\?\.routeName\}/);
 assert.match(live, /driverQueueReady=\{canJoinQueue\}/);
 assert.match(live, /driverEnrolled=\{queueMembership === "enrolled"\}/);
 assert.match(live, /request<\{ access_token: string; user: Profile \}>\("\/api\/auth\/switch-role"/);
 assert.match(live, /if \(busy \|\| driverQueueMembership\(queueSnapshotRef.current, requestSession\) !== "absent"/);
 assert.match(live, /!canJoinDriverQueue\(driverRouteGateRef.current, requestSession\)/);
 assert.match(live, /disabled=\{busy \|\| profile.driver_approval_status !== "approved"/);
});
