# Native renderer decision: MapLibre 11.5.1

Investigated 2026-11-14 for Expo **54.0.38**, React Native **0.81.5**,
React **19.1.0**, ONAY `newArchEnabled: true`. No dependency installation,
manifest/config modification, native build or heavy E2E was performed.

**Decision: GO for a bounded implementation candidate, NOT VERIFIED for native
delivery.** Pin `@maplibre/maplibre-react-native` to **11.5.1**, not an alpha,
v10 or floating latest. Its published peer ranges explicitly accept this ONAY
stack. Actual generated-project compile/link/runtime compatibility still needs
verification; peer ranges are not a successful Android build. **NO-GO for native
acceptance/production claims or production tile reliance at this stage.**

## Version-specific evidence

- [Published package metadata](https://registry.npmjs.org/@maplibre/maplibre-react-native/11.5.1)
  and [tagged package.json](https://github.com/maplibre/maplibre-react-native/blob/v11.5.1/package/package.json)
  declare peers Expo `>=54.0.0`, RN `>=0.80.0`, React `>=19.1.0`.
  GeoJSON/React type peers are optional. The package has native Fabric codegen;
  [v11 migration](https://maplibre.org/maplibre-react-native/docs/setup/migrations/v11/)
  requires the new architecture. Do not disable ONAY's new architecture.
- [Expo setup](https://maplibre.org/maplibre-react-native/docs/setup/expo/)
  requires config plugin `@maplibre/maplibre-react-native` and a rebuilt native
  app. Expo Go is unsupported. Plugin iOS Podfile integration is required even
  though Android works via autolinking/defaults.
- [Tagged Android defaults](https://github.com/maplibre/maplibre-react-native/blob/v11.5.1/package/android/gradle.properties)
  use native SDK 13.6.1, OpenGL, default location engine and minSdk fallback 24.
  Root project SDK/Kotlin values override fallback defaults. The public getting
  started page says API23; use actual tagged Gradle/merged-project requirements
  as the build authority rather than assuming API23 support from that page.
  [Tagged Gradle](https://github.com/maplibre/maplibre-react-native/blob/v11.5.1/package/android/build.gradle)
  resolves Maven Central/Google artifacts without a Mapbox download secret.
  [iOS podspec](https://github.com/maplibre/maplibre-react-native/blob/v11.5.1/package/MapLibreReactNative.podspec)
  selects native 6.31.0 via SPM.
- [Tagged Android manifest](https://github.com/maplibre/maplibre-react-native/blob/v11.5.1/package/android/src/main/AndroidManifest.xml)
  declares INTERNET and coarse/fine location only. ONAY already declares
  foreground coarse/fine and uses network APIs. No background/service permission
  is required for static stop rendering. Verify the generated merged manifest
  before accepting the dependency; do not add permissions to resolve build errors.
- [Wrapper license](https://github.com/maplibre/maplibre-react-native/blob/v11.5.1/LICENSE.md)
  is MIT. Retain copyright/license notices and audit transitive native notices
  in the actual dependency graph; SDK licensing does not license hosted tiles.
- Tagged example app currently targets Expo55/RN0.83, not ONAY's exact versions:
  [example package](https://github.com/maplibre/maplibre-react-native/blob/v11.5.1/examples/expo-app/package.json).
  No exact ONAY-stack native success is claimed from that example.

## Raster source feasibility and service boundary

[RasterSource](https://maplibre.org/maplibre-react-native/docs/components/sources/raster-source/)
supports XYZ URL templates, tileSize, zoom limits and attribution. A local
style-spec v8 object containing an HTTPS raster source, `tileSize: 256`,
`maxzoom: 19` and one raster layer is technically suitable for the existing
admin precedent `https://tile.openstreetmap.org/{z}/{x}/{y}.png`. No style token,
glyph URL, sprite service or Google Maps API key is necessary for that style.

The [OSMF policy](https://operations.osmfoundation.org/policies/tiles/) permits
ordinary interactive viewing subject to attribution, identifiable requests and
cache compliance. It provides no SLA; offline packs, bulk prefetch and headless
tile-scanning are prohibited. Keep visible OSM attribution outside a hidden
action sheet. Configure a stable app User-Agent through the host-matched
[TransformRequestManager.addHeader](https://maplibre.org/maplibre-react-native/docs/modules/transform-request-manager/),
then verify actual native requests and caching before enabling this source.
Neither API authentication nor private locations belong in tile requests.
Camera viewport/tile indices and IP still reveal approximate viewed areas to
the provider; the lack of explicit GPS query parameters is not zero disclosure.

Thus raster **format compatibility: GO**; OSMF native request/cache compliance:
**UNVERIFIED**; production service adequacy: **NO-GO until separately resolved**.
Use controlled local raster fixtures for automated render/network tests, not
automated public OSM panning. Official demo style is a development-only fallback,
not evidence of detailed street coverage in ONAY's operating area.

## Exact smallest implementation scope after integration approval

1. Dependency/config commit: mobile package.json and root pnpm lock only for
   pinned 11.5.1; mobile app.json plugin addition without new permission entries,
   existing newArch flag/provenance kept. Do not add reanimated, background
   geolocation, custom native patches, Google engine, offline packs or secrets.
   Review dependency diff and `expo config`/plugin evaluation before prebuild.
2. Add `components/PassengerRouteMap.native.tsx` with v11 `Map`, `Camera` and
   GeoJSON point source/circle layer. Coordinates convert once from `{lat,lng}`
   to `[lng,lat]`. Stable stop IDs resolve taps into existing pickup/destination
   selection rules; never submit coordinates as replacement booking stop IDs.
   Add a `.web.tsx` fallback retaining the existing list initially, so Metro Web
   never imports native MapLibre modules; implementing Leaflet web parity is a
   separate truthful task. A native implementation does not prove web parity.
3. Add pure `lib/passenger-route-map.ts` adapter for valid configured stop
   points, selected IDs and initial bounds; keep missing geometry explicit.
   Mount only in `PassengerRouteOrder.tsx` while retaining accessible list
   controls, quote/recovery guards and user-visible loading/tile-error fallback.
   No driver markers, straight-line road-route claims, ETA or fare computation.
4. Use stable local raster style and source IDs; avoid style swaps during normal
   light/dark UI transitions. Do not activate `NativeUserLocation`, MapLibre
   location hooks or OfflineManager. Existing Expo foreground GPS remains the
   sole on-demand location path. Avoid extra background native location engines.
5. Tests: pure adapter parsing/axis/order/missing points; actual component event
   tests for marker-to-stop selection and no-op stale/invalid IDs; failed source
   leaves list booking usable; unmount listener cleanup; project typecheck/unit
   suite plus Android/iOS JS export. Mocking a native component only tests JS
   behavior and cannot establish native rendering.

## Known native risks to include in the acceptance queue

Open upstream reports are observations, not proof ONAY reproduces them:
[location module reload lifecycle #1697](https://github.com/maplibre/maplibre-react-native/issues/1697),
[third-party background geolocation interaction #1698](https://github.com/maplibre/maplibre-react-native/issues/1698),
[early offline module startup #1699](https://github.com/maplibre/maplibre-react-native/issues/1699),
and [overlapping Android markers #1700](https://github.com/maplibre/maplibre-react-native/issues/1700).
Minimal scope avoids location/offline modules and view-marker stacks; nonetheless
exercise cold launch, reload, repeated booking navigation/unmount, overlapping
configured stops, raster load failure and background/foreground before native
acceptance. Do not claim issues fixed solely because scope avoids their examples.

**Native rebuild boundary:** adding this native module requires prebuild/native
compilation and a new authorized development/debug artifact; OTA/JS export and
APK119 cannot load the new module. Preserve APK119 and do not rebuild it. Record
new artifact source SHA, versionCode, dependency and merged-permission receipts,
and actual map pan/zoom/selection evidence when native verification is authorized.
Do not run heavy E2E before the confirmed 90% gate. Until then status remains
IMPLEMENTATION CANDIDATE / NATIVE UNVERIFIED, not DONE.
