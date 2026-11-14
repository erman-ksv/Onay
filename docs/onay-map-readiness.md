# ONAY interactive map readiness and implementation queue

Audit baseline: PR #110, `feat/artifact-auth-ui-v1`, source
`2cd511526bf66559be05cfd486c038a6e5cbe449`. This is an implementation plan,
not evidence that an interactive mobile map exists. Overall readiness: UNKNOWN.
No SDK installed, new secrets/OS permissions requested, APK built, or E2E run
for this document. Revalidate the security findings against the integrated HEAD
before implementing; another agent may already be correcting them.

## What the repository actually provides

| Area | Evidence | Implication |
| --- | --- | --- |
| Native/web mobile renderer | `mobile/tezjet-app/package.json` has Expo 54, React Native 0.81.5, `expo-location`, `socket.io-client`; no MapView, native map SDK, Leaflet or WebView dependency | No interactive passenger map today. Admin dependencies are not mobile dependencies. |
| Existing map precedent | `artifacts/mockup-sandbox/src/admin/StopMapPicker.tsx` uses Leaflet 1.9.4 and HTTPS OpenStreetMap raster tiles with attribution, tile-error fallback, disposal and longitude normalization | Reuse the interaction/error-handling approach for Expo Web, not the DOM component in native React Native. Public tile access does not establish production capacity or service permission. |
| Permissions | `mobile/tezjet-app/app.json` enables foreground coarse/fine location only, Android versionCode 119; iOS foreground purpose string | Keep existing on-demand GPS flow; do not add background location, foreground services, automatic tracking or new permissions. |
| Static geometry | `types/domain.ts` defines optional `RouteStop.location`; `utils/driverRoute.ts:driverRouteOption` returns configured stops, including locations; configured A/B endpoints require valid coordinates, intermediate stops may lack them | `/api/orders/routes` already exposes static coordinates for authenticated passengers. Do not invent intermediate geometry or require every historical stop to have coordinates. |
| Mobile route parsing | `mobile/tezjet-app/lib/driver-routes.ts:parseDriverRoute` retains ID/code/name/sequence/position but drops location | First implementation can preserve validated optional coordinates without changing API or dispatch. |
| Selection and booking | `PassengerRouteOrder.tsx`, `lib/passenger-route-orders.ts` validate ordered stop IDs, direction, route revision, seats, quote freshness, idempotency/recovery and device GPS | Marker taps must call the same selection path; retain list selection and all submission guards. Arbitrary map points are not valid configured-stop bookings. |
| Order geometry | `utils/serialize.ts:serializeOrder` emits route stops, stop IDs, route context and pickup location; mobile `lib/orders.ts:RideOrder` does not model these fields | Add an allowlisted validated map adapter rather than render an untyped server object. |
| Driver location ingress | `routes/queue.ts` protects location PATCH with authentication, driver role, approval and `antiFakeGPS`; queue data includes real locations | A stored queue position is not automatically a passenger-authorized live marker. |
| Current raw socket event | Baseline `socket.ts` handler for `driver:location` broadcasts the caller's raw location globally after driver identity checks | BLOCKER: no payload validation or order relationship check. Do not subscribe the map to this event. Escalated to Orchestrator/Security. |
| Queue privacy | `services/queueView.ts` returns lane-filtered snapshots; `utils/realtime.ts:emitQueueUpdate` broadcasts the legacy queue room; all baseline connections join that room | Security must review exact fields and audiences before queue data is used as a marker source. Lane membership alone is not a map disclosure policy. |

## Minimal phased delivery

1. **Geometry/model, independent of renderer (Maps + Backend review).** Extend
   parsed route stops with optional `{lat, lng}`; allowlist only finite numeric
   values in geographic range, dropping telemetry timestamps/mock flags from
   static display models. Invalid supplied geometry must fail closed for map
   display, without making valid list-only routes unusable. Derive selected
   A/B coordinates from stable stop IDs and current route revision. For reverse
   direction reverse stop order, never coordinates or latitude/longitude axes.
   Keep geometry unavailable explicit. Do not interpolate missing stops as facts.

2. **Accessible stop preview (Maps + Frontend, then UI/UX).** Mount a map panel
   only on the existing booking screen; marker presses select existing stops
   through the same ordering rules as the list. Show current selection, fit
   valid points, preserve pan/zoom across unrelated state changes, and provide
   list controls and visible loading/error/offline states. GPS remains an
   explicit action after foreground permission; permission denial must leave
   route selection usable. No tokens, phone numbers, order IDs or GPS coordinates
   in tile URLs, telemetry, logs or durable client storage. Existing booking
   recovery records remain minimal and separate from map data.

3. **Renderer decision before dependency changes (Maps + Android).** For Expo
   Web, a platform-specific lazy Leaflet adapter is a concrete key-free option
   matching the existing admin implementation. For native, evaluate a key-free
   MapLibre adapter against Expo 54/RN 0.81/new architecture and the selected
   tile/style endpoint; compatibility is NOT VERIFIED. `react-native-maps`
   Google Android configuration is not ready: no API key is configured and this
   task does not authorize acquiring one. A WebView renderer also adds a native
   dependency and security surface; it is not already available. Do not present
   a web-only map as Android completion. Avoid an SDK decision until an actual
   compatibility check and dependency/security review establish the native path.
   No paid accounts, new secrets, permission expansion, build or production tile
   deployment is implied by this plan. A development tile source must retain
   attribution and comply with its usage policy; production capacity remains
   a separate unresolved dependency.

4. **Honest route display (Maps + Backend).** Existing stops support a stop
   preview and optionally straight segments explicitly labelled as a stop
   schematic. They do not provide road-following route geometry, turn-by-turn
   instructions, travel distance or ETA. No routing/geocoding provider is
   configured. A road route requires an explicit versioned geometry contract
   from an available authorized source; never label a straight line as a road
   route or derive fare/FIFO from map distance. Arbitrary address search is
   likewise outside the configured-stop API and cannot silently replace it.

5. **Secure real driver telemetry (Backend + Security, then Maps).** Before
   consuming any event, define and test an order-authorized, allowlisted payload
   (`order_id`, matching assigned `driver_id`, coordinates, observation time).
   Recheck sender role/approval/session and recipient's current order relationship;
   reuse location validation and anti-fake protections. Stop delivery and clear
   cached markers on completion, cancellation, reassignment, logout, role/server
   change or expired/revoked session. Do not widen delivery to all passengers,
   queue members or neighboring routes. Product/security must explicitly define
   any broader pre-booking driver visibility before implementation. Display only
   real authorized observations; mark stale/disconnected data explicitly and
   remove it on authorization loss. No synthetic drivers, simulated movement or
   unearned ETA. Exact freshness thresholds are to be agreed as a telemetry
   contract, not invented as existing business rules.

6. **Integration and Android acceptance (Integration + QA + Android).** Review
   small commits independently, run deterministic tests and existing CI, then
   platform rendering smoke checks. APK119 cannot contain any newly added native
   SDK; preserve its provenance and existing evidence. Build only when a concrete
   native change needs validation and the applicable build authorization is met.
   Heavy E2E remains forbidden until the owner's confirmed 90% readiness gate.
   Unit/integration evidence alone cannot claim native map acceptance.

## Acceptance checks before DONE

- Pure geometry tests: absent/partial stops, valid `(0,0)`, non-finite and
  out-of-range values, duplicates, reverse direction, selected segment and route
  revision changes. No fabricated geometry or price changes.
- Booking regression: marker/list selections produce identical validated stop
  IDs; invalid pickup-after-destination is rejected; selecting another segment
  invalidates its quote; slow/denied/unavailable GPS performs no booking POST;
  timeout and late native result cannot bypass the submission gate.
- Renderer checks: drag/zoom and fit work; selection has accessible text/list
  equivalents; small viewport and light/dark labels readable; unmount disposes
  listeners; tile failures leave booking/list controls usable. Network inspection
  proves tile requests carry no app credentials or personal data. No snapshot
  alone is evidence of interactivity.
- API/socket integration tests: matching order participant receives valid
  telemetry; unrelated passengers, drivers and routes do not; malformed payload,
  revoked/expired session, unapproved sender and authorization loss deliver no
  update. Test terminal order/reassignment boundaries and payload allowlists.
  Baseline `test/socket-errors.test.mjs` expects a global broadcast in one
  regression: update it to assert authorized delivery while preserving its
  original database-error recovery protection.
- Reconnect/out-of-order tests: ignore older observations, clear on endpoint
  or account change, do not retain another user's marker, do not treat stale
  coordinates as live. Use deterministic clocks and real test sockets, not
  production data or heavy E2E.
- Native gate: record exact source SHA, SDK/config, platform/device, tests,
  screenshots and provenance for the actual artifact when a build is authorized.
  Web success and historical APK119 success are separate evidence.

Current status: PLAN ONLY. Geometry adapter, renderer, protected telemetry,
road-routing contract and native acceptance are NOT IMPLEMENTED by this plan.
