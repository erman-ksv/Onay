import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const app=readFileSync(new URL("../app/index.tsx",import.meta.url),"utf8");
const shell=readFileSync(new URL("../components/OnayPassengerScreens.tsx",import.meta.url),"utf8");
const passengerApp=app.slice(app.indexOf('if (token && profile && activeRole === "passenger"'), app.indexOf('return <OnayDriverShell'));
const profile=readFileSync(new URL("../components/OnayPassengerProfile.tsx",import.meta.url),"utf8");
const history=readFileSync(new URL("../components/PassengerHistory.tsx",import.meta.url),"utf8");
const qa=readFileSync(new URL("../../../scripts/line-ride-browser-qa.py",import.meta.url),"utf8");

test("four unique screens keep separate scroll containers with hidden-tab access gated",()=>{
  for(const id of ["home","trips","chats","profile"]) assert.ok(app.includes(id+"={<>"));
  for(const id of ["Home","Trips","ChatsEmpty","Profile","TabBar"]) assert.equal((passengerApp.match(new RegExp("<OnayPassenger"+id+"\\b","g"))??[]).length,1);
  assert.ok(shell.includes("pages.map(page =>"));
  assert.ok(shell.includes('style={[styles.page, !selected && styles.inactive]}'));
  assert.ok(shell.includes('importantForAccessibility={selected ? "auto" : "no-hide-descendants"}'));
  assert.ok(shell.includes('pointerEvents={selected ? "auto" : "none"}'));
  assert.ok(shell.includes('scrollEnabled={selected}'));
  assert.ok(shell.includes("useSafeAreaInsets()"));
  assert.ok(!app.includes("onayPassengerTabScrollY(tab,"));
});
test("booking remains fully server-backed and only visible in Home",()=>{
  const h=app.indexOf("home={<>"),t=app.indexOf("trips={<>"),c=app.indexOf("chats={<>"),p=app.indexOf("profile={<>");
  assert.ok(h>=0 && t>h && c>t && p>c);
  const home=app.slice(h,t),trips=app.slice(t,c);
  for(const x of ["<PassengerRouteOrder key=",'testID="onay-passenger-legacy-route"','testID="onay-legacy-book-trip"',"bookingGate={bookingGate}"])assert.ok(home.includes(x));
  for(const x of ["<OnayPassengerTrips","<PassengerDriverCard","onPress={() => cancelOrder(passengerOrder)}","<PassengerHistory key="])assert.ok(trips.includes(x));
  assert.ok(history.includes('validateApiEndpoint(endpoint) + "/api/orders"'));
  assert.ok(history.includes('generation.current === ticket && !controller.signal.aborted'));
  assert.ok(app.includes("setHomeScrollTarget(previous => ({ section: target.section"));
});
test("hardware back returns correctly from Trips history and profile nested screens",()=>{
  assert.ok(app.includes('BackHandler.addEventListener("hardwareBackPress"'));
  assert.ok(app.includes('if (passengerTab === "trips" && tripsHistoryOpen)'));
  assert.ok(app.includes('closePassengerHistory(); return true;'));
  assert.ok(app.includes('setPassengerTab(historyReturnTab.current)'));
  assert.ok(app.includes('if (passengerTab !== "home")'));
  assert.ok(profile.includes('BackHandler.addEventListener("hardwareBackPress"'));
  for(const id of ["supportOpen","aboutOpen","personalOpen"])assert.ok(profile.includes("if ("+id+")"));
  assert.ok(app.includes('onBackToHome={() => setPassengerTab("home")}'));
});
test("browser QA switches the real tabs and continues to inspect genuine API history",()=>{
  assert.ok(qa.includes('for tab in ("trips", "chats", "profile", "home")'));
  assert.ok(qa.includes('get_by_test_id("onay-screen-" + tab)).to_be_visible()'));
  assert.ok(qa.includes('get_by_test_id("onay-screen-home")).to_be_hidden()'));
  assert.ok(qa.includes('get_by_test_id("onay-profile-history").click()'));
  assert.ok(qa.includes("Passenger history must read the real authorized API"));
});
