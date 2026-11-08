import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalizeOnayContactEmail } from "../lib/onay-contact-email.ts";
import { driverModeStatus, driverModeReadyForQueue } from "../lib/onay-driver-mode-status.ts";
const read = path => readFileSync(new URL(path, import.meta.url), "utf8");
const vehicle = { make:"Chevrolet", model:"Cobalt", plate_number:"TST", seat_capacity:4 };

test("personal details: only email edits; full_name is never split or rewritten", () => {
 const details=read("../components/OnayPersonalDetails.tsx");
 const profile=read("../components/OnayPassengerProfile.tsx");
 const app=read("../app/index.tsx");
 for(const id of ["onay-profile-personal-name","onay-profile-personal-surname","onay-profile-personal-phone","onay-profile-personal-email","onay-personal-email-save"]) assert.ok(details.includes(id));
 assert.match(details,/family \?\? "Не хранится отдельно"/);
 assert.match(details,/В аккаунте имя и фамилия сохранены одной строкой/);
 assert.doesNotMatch(details,/fullName\.split|split\(" "\)|split\(' '\)/);
 assert.match(details,/onSaveEmail\(normalized\)/);
 assert.match(details,/busyRef\.current/);
 assert.match(details,/Сервер не подтвердил сохранение email/);
 assert.match(details,/demoMode \|\| !onSaveEmail/);
 assert.match(profile,/email=\{email\}/);
 assert.match(app,/body: JSON\.stringify\(\{ email: nextEmail \}\)/);
 assert.doesNotMatch(app,/JSON\.stringify\(\{ email: nextEmail, full_name/);
});
test("email normalization handles clearing, errors and refuses invalid contacts",()=>{
 assert.equal(normalizeOnayContactEmail(""),null);
 assert.equal(normalizeOnayContactEmail("    "),null);
 assert.equal(normalizeOnayContactEmail("  Person@Example.ORG "), "person@example.org");
 for(const invalid of ["a@@b.com","x", "a b@c.com", "x@localhost", "a".repeat(65)+"@x.com"]) {
   assert.throws(()=>normalizeOnayContactEmail(invalid),/email/);
 }
});
test("driver vehicle: no approval inferred from missing or failed API response",()=>{
 const ui=read("../components/OnayDriverModeOverview.tsx");
 assert.equal(driverModeStatus("pending",null),"unfilled");
 assert.equal(driverModeStatus("pending",vehicle),"pending");
 for(const s of ["rejected","blocked","approved"])assert.equal(driverModeStatus(s,vehicle),s);
 assert.match(ui,/onLoadVehicle\?: \(\) => Promise<VehicleSnapshot>/);
 assert.match(ui,/testID="onay-driver-mode-load-error"/);
 assert.match(ui,/testID="onay-driver-mode-retry"/);
 assert.match(ui,/setSnapshot\(null\)/);
 assert.match(ui,/testID="onay-driver-mode-vehicle-form"/);
 assert.match(ui,/status === "unfilled" \|\| status === "rejected"/);
 assert.match(ui,/review_reason \|\| "Причина отказа не предоставлена сервером/);
 assert.match(ui,/testID="onay-driver-mode-plate"/);
 assert.match(ui,/testID="onay-driver-mode-seats"/);
 assert.match(ui,/testID="onay-driver-mode-route"/);
 assert.match(ui,/testID="onay-driver-mode-readonly-online"/);
 assert.match(ui,/accessibilityState=\{\{ checked: onLine, disabled: true \}\}/);
 assert.equal(driverModeReadyForQueue("approved",vehicle,true,true),true);
 for(const denied of [null,"pending","rejected","blocked"]) assert.equal(driverModeReadyForQueue(denied,vehicle,true,true),false);
});
test("passenger own snapshot read is authenticated without role mutation; submission remains driver-only",()=>{
 const routes=read("../../../artifacts/api-server/src/routes/driver.ts");
 const controller=read("../../../artifacts/api-server/src/controllers/driverController.ts");
 const app=read("../app/index.tsx");
 assert.match(routes,/router\.get\("\/driver\/vehicle", authenticate, requireRole\("driver"\), getDriverVehicle\)/);
 const authRoutes=read("../../../artifacts/api-server/src/routes/auth.ts");
 assert.match(authRoutes,/router\.get\("\/auth\/driver-overview", authenticate, getOwnDriverOverview\)/);
 assert.match(routes,/router\.put\("\/driver\/vehicle", authenticate, requireRole\("driver"\), setDriverVehicle\)/);
 assert.match(controller,/await store\.getUser\(request\.auth!\.userId\)/);
 assert.match(controller,/route_name: route\?\.active \? route\.name : null/);
 assert.match(app,/onOpenDriverVehicle=\{\(\) => \{ void switchMode\("driver", true\); \}\}/);
 assert.match(app,/if \(openVehicle\) setDriverSubpage\("vehicle"\)/);
 assert.doesNotMatch(read("../components/OnayDriverModeOverview.tsx"),/joinQueue\(|socket\.emit\(/);
});
