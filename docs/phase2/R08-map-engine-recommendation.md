# R08 — ONAY map engine recommendation

Research measured 2026-11-17 12:06–12:12 UTC. Isolated branch `phase2-maps`,
base `135d849afeb6ee226a1531b822041cf13d6f5c36`; PR110 only. **R08 is technical
research, not SDK selection approval or implementation. R09/R10 NOT STARTED.**
No dependency install, app/config/workflow change, permission grant, key/account,
paid service or APK build. Native compilation/rendering checks: NOT RUN.

Research status: **COMPLETE / REVIEWABLE**. R08 task status:
**BLOCKED_OWNER_DECISION**, not DONE; provider/permission decisions and native
evidence remain outstanding. Node22/native compatibility is UNVERIFIED beyond
the source/metadata checks explicitly listed below.

## Recommendation and actual decision boundary

**Technical first choice: MapLibre Native through pinned
`@maplibre/maplibre-react-native@11.5.1`, subject to owner permission approval,
a usable licensed tile source and an actual Node22/native compile spike.**
It offers native pan/zoom, camera, GeoJSON stop/driver markers and configurable
vector styling suitable for the requested 2GIS-like map interaction without
requiring a new vendor key for the renderer itself. This is a recommendation,
not authorization to install it. Its two proven new Android permissions remain
pending; ignoring them would violate the owner boundary.

If the owner prefers Google data/service operations and authorizes its account,
key and manifest changes, use **react-native-maps as the Google alternative**.
Keep Expo54's 1.20.1 default distinct from a tested Fabric-version choice; do not
blindly install latest. Google is not a zero-permission fallback. If new native
permissions are declined, retain WebView13.15.0/local Leaflet1.9.4 as a fallback
candidate, with the previously documented bridge/provider/cache review gates.
Literal 2GIS SDK is a real current RN option, but its proprietary/keyed
integration with unverified Expo54 stability is a separate commercial choice rather than the fastest
low-dependency completion path for ONAY.

No option currently satisfies every delivery gate. Overall readiness remains
UNKNOWN. A screen looking like 2GIS and a licensed 2GIS basemap are different
requirements; pan/zoom, bottom sheet, stop markers, recenter and clear selection
feedback can be designed in ONAY without copying proprietary content or branding.

## Existing architecture to preserve

Current frozen mobile manifest/lock resolves Expo54.0.38, RN0.81.5, React19.1;
Mobile CI uses Node22 and pnpm10.34.9. Renderer is absent. Foreground GPS uses
expo-location19.0.8; keep that on-demand path, bounded passenger GPS wait and
permission-denial UI. Do not add background tracking or a second location engine
just to display a map.

`GET /api/orders/routes` returns configured stop coordinates; the integrated
mobile route parser now retains validated optional `{lat,lng}`. Existing stop
IDs, direction/revision, segment ordering, availability/fare freshness,
idempotency and recovery remain the booking contract. Map selection must call
that same path. A free-point tap can move the camera or select an actual stop;
it cannot silently become a configured-stop booking or change dispatch rules.

Current `socket.ts` validates driver locations and delivers only to authorized
passengers on active assigned orders, rechecking account/session relationships.
The old global broadcast finding in historical map-readiness notes was fixed;
do not reopen it as current behavior. This is not a pre-booking fleet-marker API.
Do not fabricate drivers or expose the queue as all nearby drivers. A client
telemetry adapter still needs stale/out-of-order/session/closed-order tests.
Stop sequences are available; road-following geometry, accurate travel ETA and
turn-by-turn navigation are separate source/contracts. A renderer or straight
line does not implement routing. Fare/FIFO remain server-authoritative.

## Version-specific stack comparison

The actual [Expo54.0.38 tarball](https://registry.npmjs.org/expo/-/expo-54.0.38.tgz)
bundled-native list declares react-native-maps1.20.1, expo-maps~0.12.10 and
react-native-webview13.15.0. Public versioned Expo pages sometimes redirect to
new SDK versions; the pinned package is the version authority for this report.

| Option and inspected version | Node22 / RN0.81.5 evidence | Capabilities and limitations |
| --- | --- | --- |
| MapLibre11.5.1, Native Android13.6.1 | Published peers Expo>=54, React>=19.1, RN>=0.80; Fabric/new architecture only. No package engines restriction declared. Upstream development Node24 does not itself mandate changing ONAY CI. Actual full Node22/transitive/native build remains UNVERIFIED. | Native gestures/camera/layers; key-free renderer, separate map data/routing. Expo plugin and rebuilt standalone binary required; not Expo Go. |
| react-native-maps1.20.1, Google Android18.2.0 defaults | Expo54 exact bundled version; Node>=18 metadata. Older interop path differs from modern Fabric implementation. | Google native gestures/markers/polylines; requires Google key/billing. Existing expo-location can remain GPS owner. |
| react-native-maps1.29.11, Google19.1.0 defaults | Registry latest measured now; engines Node>=20.19.4. Upstream Fabric table requires RN>=0.81.1 for1.26.1+, met by0.81.5. Still no ONAY native test. | Possible explicit Fabric spike candidate, not automatically Expo54's supported Expo-Go binary. Wider native dependency change; do not swap versions without review. |
| expo-maps0.12.10 | Exact SDK54 range; Expo-module/Compose path. Package wildcard peers are not a native compile test. | Google on Android, Apple on iOS; documented alpha API risk, no web map parity. Retains Google account/key requirements. Lower priority than a focused RN maps spike. |
| WebView13.15.0 + Leaflet1.9.4 | Exact Expo54 bundled WebView; prior full default WebKit AAR-branch inspection and security preflight exist. | Real interactive raster map, with local scripts; CSP/bridge, opaque-origin cache and native performance/accessibility must be verified. No fake positions. |
| Official @2gis/dgis-mobile-sdk-map14.2.1 | Registry peers React>=18/RN>=0.74, safe-area^5.5.2 and SVG>=13; ONAY lacks SVG. No Node engine declared. Native codegen/manual AAR integration, not an Expo54 compile guarantee. | Official RN SDK exists. Requires dgissdk.key and proprietary terms; exact compiled permission graph/Node22/native compatibility UNVERIFIED. |
| @rnmapbox/maps10.3.18 | Registry peers Expo>=47/RN>=0.79, no Node engine declared; compilation not tested. | Worthy native styling alternative, but vendor token/account and MAU billing introduce approval/operations scope without resolving ONAY's current permissions gate. |

Version sources:
[MapLibre metadata](https://registry.npmjs.org/@maplibre/maplibre-react-native/11.5.1),
[setup](https://maplibre.org/maplibre-react-native/docs/setup/expo/),
[RN maps1.20.1](https://registry.npmjs.org/react-native-maps/1.20.1),
[1.29.11](https://registry.npmjs.org/react-native-maps/1.29.11),
[upstream compatibility table](https://github.com/react-native-maps/react-native-maps#react-native-compatibility),
[expo-maps0.12.10](https://registry.npmjs.org/expo-maps/0.12.10),
[2GIS14.2.1](https://registry.npmjs.org/@2gis/dgis-mobile-sdk-map/14.2.1),
[Mapbox wrapper10.3.18](https://registry.npmjs.org/@rnmapbox/maps/10.3.18).
Version/peer acceptance does not imply absence of native Kotlin/Gradle/codegen
conflicts. Do not disable typechecks, security controls or CI to make a spike pass.

## Permission and native capability comparison against actual APK119

Reuse the SHA-pinned actual APK119 badging/receipt evidence in
`docs/evidence/onay-maplibre-permissions.json`: minSdk24, coarse/fine location
and INTERNET already present; no NETWORK_STATE/WIFI_STATE/WAKE_LOCK/
RECEIVE_BOOT_COMPLETED/FOREGROUND_SERVICE. Current app.json alone is not the
compiled baseline. No APK119 rebuild or new artifact test was needed here.

- **MapLibre:** published android-sdk-opengl13.6.1 AAR adds NETWORK_STATE and
  WIFI_STATE plus optional Wi-Fi hardware, with native minSdk23/wrapper24.
  Existing preflight establishes purpose and no proven safe exclusion. Owner
  decision still pending. Inspected manifests add no background location or
  storage; actual future merged graph remains UNVERIFIED.
- **Google through RN maps:** directly inspected play-services-maps18.2.0 and
  19.1.0 AARs add NETWORK_STATE and required OpenGL ES2, not just an empty RN
  wrapper manifest. RN maps' declared work-runtime2.7.1/2.9.1 AARs additionally
  declare WAKE_LOCK, RECEIVE_BOOT_COMPLETED and FOREGROUND_SERVICE, with startup
  provider/services/receivers. Do not label Google permission-free or infer
  background location from a foreground-service permission alone. These are
  proven dependency declarations, not a completed ONAY manifest merge; root
  resolution might differ, so any approved spike must capture the actual delta.
  No exclusion workaround is proposed. Inspected location21.3.0 AAR itself has
  no uses-permission elements; other Google transitives are not fully audited.
- **Expo Maps/2GIS/Mapbox:** complete selected native manifests not inspected;
  permission delta UNKNOWN, not zero. They cannot bypass approval by inference.
- **WebView:** no permissions in the previously inspected complete default
  WebKit AAR branch, but actual ONAY resolved graph is UNVERIFIED; payment
  queries and non-exported wide-path FileProvider are a separate review gate.

Published RN dependency sources:
[1.20.1 Gradle](https://github.com/react-native-maps/react-native-maps/blob/v1.20.1/android/build.gradle),
[1.29.11 Gradle](https://github.com/react-native-maps/react-native-maps/blob/v1.29.11/android/build.gradle).
Exact inspected AAR hashes and direct URLs are in the companion R08 evidence.

## Data sources, attribution, coverage and cost

**MapLibre is a renderer, not a free production map/search/routing service.**
Existing admin OSM raster integration demonstrates an approach, not native
acceptance or a service SLA. OSMF attribution/app identity/cache obligations and
no bulk/offline/public automated sweeps remain in the prior native policy plan.

A worthy key-free vector candidate is **OpenFreeMap**. Its
[official site](https://openfreemap.org/) advertises commercial use, no account,
keys or cookies, and a free public instance without view/request limits; it
explicitly offers no SLA. Its [mobile quick start](https://openfreemap.org/quick_start/)
supports MapLibre Native styles and requires carrying OpenMapTiles/OSM
attribution. This is a stronger candidate than treating MapLibre demo tiles as
street-level production data. **Actual single GET of its Liberty style returned
HTTP403 in this execution environment on2026-11-17**; no retries, proxy or bypass
were attempted. SDK/device availability is therefore UNVERIFIED, not disproven
or accepted. No production recommendation can rely on an endpoint merely because
its documentation loads. Operating-city coverage, labels and service availability
need real acceptance; self-hosting would require a separately approved ops/cost
plan. No self-hosting work starts here.

**Google:** [setup](https://developers.google.com/maps/documentation/android-sdk/get-api-key)
requires enabled billing and an API key restricted to package/certificate and
approved APIs. The [current global pricing list](https://developers.google.com/maps/billing-and-pricing/pricing)
lists the Maps SDK SKU with unlimited free usage; this is different from web
Dynamic Maps and Routes/Places SKUs. Do not assume a paid subscription is needed
for native base-map display, nor that all Google features are free. Owner's
account/contract, geography, enabled SKUs and expected request volume are UNKNOWN;
no monthly quote is invented. Retain
[Google Maps attribution/content restrictions](https://developers.google.com/maps/documentation/android-sdk/policies)
and do not treat provider data as freely interchangeable with other maps.

**2GIS:** [official RN setup](https://docs.2gis.com/en/react-native/sdk/start)
requires dgissdk.key, provider Maven repository and application asset setup;
demo keys are time-limited and production requires the relevant subscription.
The current inspected package license is proprietary; public peer ranges are
not an Expo plugin. The [release page](https://docs.2gis.com/en/react-native/sdk/releases/latest)
still describes the initial14.0.0 release as preliminary while registry has
14.2.1; do not invent a stability guarantee. It supports region/language choices
including RU/UZ/KZ in docs, but exact operating-route data quality and subscription
price are UNKNOWN. No key/demo account was created.

**Mapbox:** wrapper MIT does not license service data; official
[Android SDK pricing](https://docs.mapbox.com/android/maps/guides/pricing/)
uses mobile MAUs. Exact account tier, free allowance and ONAY cost remain UNKNOWN.
No token or subscription acquired. All provider logos/attributions stay visible
and all third-party content must follow its own terms, not the wrapper's license.

## Minimal integration proposal for later authorization, not R09/R10 execution

1. Owner decides engine and native permission scope, acceptable tile service/
   availability, operating cities and whether road routing/search is required.
   Prefer a first milestone of real stop selection and GPS on an interactive
   map; confirm any production SLA or paid provider separately. Existing pending
   permission question does not become approval through silence.
2. After that decision, pin chosen dependency in the existing isolated mobile
   lock strategy; preserve Node22/pnpm policy. Run metadata/config and actual
   merged-manifest/dependency checks before building. Additional permissions or
   paid credentials beyond the reviewed choice require their own decision.
3. Add one platform-specific native map panel in PassengerRouteOrder, with a
   small pure geometry adapter. Preserve list/accessibility controls. Convert
   coordinate axes once; map taps resolve current configured stop IDs, never
   invented stops/GPS/fare. Stable camera state, recenter, selected A/B contrast,
   light/dark controls and 320dp behavior provide the desired tactile UX.
4. Keep existing Expo foreground GPS owner, permission denial/timeout feedback,
   no background watch. A driver marker appears only from actual authorized
   current assigned-driver data. Reset it on session/server/order change and
   terminal state; handle stale/out-of-order/reconnect honestly. No pre-booking
   simulated fleet, speculative coordinates or promise that a map makes dispatch
   live. Routes remain existing configured selection until a separately reviewed
   road-geometry contract exists.
5. Test pure selection/geometry and telemetry boundaries, appropriate component
   behavior, project typecheck/unit/CI and JS exports. Native renderer acceptance
   requires a future **authorized** artifact with provenance/merged permissions,
   bounded controlled tile fixture and actual Android pan/zoom/selection evidence.
   Existing APK119 cannot prove newly introduced native code. Retain the native
   fixture strategy already documented; no deferred heavy E2E before90% gate.
   Public OSM sweeps, disabling CI/security and repeated APK builds are excluded.

UI/UX review criteria (recommendations, not a newly approved design): preserve
the pinned V2 shell/logo/palette/navigation, while the existing grid/schematic
must not be presented as GPS. Verify real gestures, current A/B stop labels,
reverse-order selection guards and unchanged recovery/quote state on tile failure.
Every control/state/accessibility label needs RU/KK/UZ coverage, list/TalkBack
alternatives, 48dp touch targets and readable 320/390dp/light-dark/font-scale
layout with attribution/safe areas. Do not mount a networked map in the isolated
offline demo; retain its no external requests/API/sockets/GPS boundary.

**Owner decisions pending:** MapLibre's two permissions or another fully
reviewed engine delta; service/key/billing only if selected; tile-source/coverage/
SLA expectations; scope of road routes versus configured stop selection. Routine
code changes after authorization remain autonomous. This report supplies concrete
choices and evidence without starting R09 or R10.
