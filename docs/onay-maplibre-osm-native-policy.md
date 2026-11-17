# MapLibre 11.5.1 native OSM raster policy investigation

Measured research window: 2026-11-15 04:19–04:25 UTC. Continues
`onay-maplibre-compatibility.md`; no repeated application audit. No dependencies,
workflows, app source, manifests, SDK installations or APKs changed. No native
tests or heavy E2E executed. Research baseline maps HEAD:
`0c1fb21b3268da6e0bca319def15a7553384f472`.

**Decision: conditional GO for implementation using supported APIs; native
request/cache/attribution acceptance remains UNVERIFIED.** There is no proven
need for a new paid service or secret for the raster format. **Superseded
permission assumption:** subsequent native AAR inspection proves two new Android
permissions versus APK119; SDK addition is BLOCKED pending owner decision (see
`onay-maplibre-permissions-preflight.md`). Do not enable public OSM tiles as an accepted native
integration until the verification below passes. Production availability remains
best-effort, not an SLA. This document does not authorize a build.

## 1. Request identity: exact source resolves the API question

The wrapper's tagged
[TransformRequestManager.ts](https://github.com/maplibre/maplibre-react-native/blob/v11.5.1/package/src/modules/transform-request/TransformRequestManager.ts)
provides `addHeader({id, match, name, value})` and `removeHeader(id)`.
For ONAY, the smallest explicit identity is a stable app/version/package value
such as `Onay/0.1.0 (uz.tezjet.app)`; use validated build configuration, never
user/account/session data. Scope it to the exact HTTPS tile host:

```ts
TransformRequestManager.addHeader({
  id: "onay-osm-user-agent",
  match: "^https://tile\\.openstreetmap\\.org/",
  name: "User-Agent",
  value: "Onay/0.1.0 (uz.tezjet.app)",
});
```

This is an implementation sketch, not executed code. Register once before a
network style/source is mounted, with explicit lifecycle ownership. Remove only
ONAY's registration when its owner shuts down; do not call global `clear()` or
erase other resource transforms. Multiple map instances need a shared owner or
reference count. Do not copy API Authorization headers into this manager.

On Android, tagged
[TransformRequestInterceptor.kt](https://github.com/maplibre/maplibre-react-native/blob/v11.5.1/package/android/src/main/java/org/maplibre/reactnative/modules/TransformRequestInterceptor.kt)
applies host matching then `requestBuilder.header(name,value)`, replacing the
existing header before forwarding the request. No User-Agent exclusion exists.
[MLRNTransformRequestModule.kt](https://github.com/maplibre/maplibre-react-native/blob/v11.5.1/package/android/src/main/java/org/maplibre/reactnative/modules/MLRNTransformRequestModule.kt)
installs this interceptor through the native SDK's HTTP client override.
Registration posts work to the UI queue and exposes no acknowledgement promise:
`await addHeader(...)` is not proof the first request has been configured.
Capture the first request after cold launch as part of acceptance.

The underlying Android SDK also constructs an app-specific default, not just a
generic okhttp identity:
[HttpIdentifier.java, android-v13.6.1](https://github.com/maplibre/maplibre-native/blob/android-v13.6.1/platform/android/MapLibreAndroid/src/main/java/org/maplibre/android/http/HttpIdentifier.java)
uses installed package/versionName/versionCode, and
[HttpRequestImpl.java](https://github.com/maplibre/maplibre-native/blob/android-v13.6.1/platform/android/MapLibreAndroid/src/main/java/org/maplibre/android/module/http/HttpRequestImpl.java)
adds SDK/platform details. This makes the initial native identity more specific
than a generic library default, but is not a substitute for captured evidence
of the explicitly configured ONAY value. If registration ordering cannot be
verified, keep the public source disabled rather than invent a delay guarantee.

On iOS,
[MLRNTransformRequest.m](https://github.com/maplibre/maplibre-react-native/blob/v11.5.1/package/ios/modules/transform-request/MLRNTransformRequest.m)
sets matching header values in `willSendRequest`. Native
[http_file_source.mm, ios-v6.31.0](https://github.com/maplibre/maplibre-native/blob/ios-v6.31.0/platform/darwin/core/http_file_source.mm)
adds its app-name/bundle-ID/version User-Agent before calling that delegate, so
the wrapper override is applied afterwards. Native apps do not need a fabricated
browser Referer; never impersonate a browser or another app.

## 2. Cache: use native persistent ambient cache, not a custom downloader

The absence of an OkHttp disk-cache constructor in the wrapper does **not**
mean tiles have no local cache. Exact native source shows the complete path:

- [Android HTTP bridge](https://github.com/maplibre/maplibre-native/blob/android-v13.6.1/platform/android/MapLibreAndroid/src/cpp/http_file_source.cpp)
  reads Cache-Control/Expires/ETag/Last-Modified from the HTTP response;
  `HttpRequestImpl.java` emits If-None-Match or If-Modified-Since for prior data.
- [main_resource_loader.cpp](https://github.com/maplibre/maplibre-native/blob/android-v13.6.1/platform/default/src/mln/storage/main_resource_loader.cpp)
  reads database data first, propagates prior expiration/validators and forwards
  fetched responses back to the database.
- [offline_database.cpp](https://github.com/maplibre/maplibre-native/blob/android-v13.6.1/platform/default/src/mln/storage/offline_database.cpp)
  stores ordinary tile data and etag/expires/must-revalidate/modified in SQLite;
  its name does not require an offline-pack feature.
- [online_file_source.cpp](https://github.com/maplibre/maplibre-native/blob/android-v13.6.1/platform/default/src/mln/storage/online_file_source.cpp)
  schedules network access using prior expiry instead of immediately downloading
  every cached tile again. No header-ignoring seven-day JS timer is required
  when these response headers are readable.
- iOS `http_file_source.mm` performs analogous validator/expiry processing.
  [MLNNetworkConfiguration.mm](https://github.com/maplibre/maplibre-native/blob/ios-v6.31.0/platform/darwin/src/MLNNetworkConfiguration.mm)
  disables NSURLCache because the native resource database is the relevant cache;
  do not misread that as permission to bypass server freshness. Verify actual
  outgoing headers, including the absence of forced no-cache, on the final app.

Minimal implementation: retain this persistent ambient cache and stable tile
URL, avoid cache-busting query parameters, volatile-source options and routine
clear/invalidate calls. Do not create/download regions, pre-seed routes, offer
offline maps or set custom no-cache headers. Preserve server expiry/validators;
do not override response headers to make a test pass. Verify repeated normal
viewing fits cache capacity without unnecessary re-downloads. The wrapper's
v11.5.1 Map/RasterSource interfaces do not expose a prefetch-disable prop: do not
invent one. Measure actual requested tiles for a bounded viewport; if SDK
look-ahead fails the service policy, source enablement remains NO-GO until an
available supported compliant configuration is established.

## 3. Attribution: add visible text; the native button is insufficient alone

Tagged [RasterSource.tsx](https://github.com/maplibre/maplibre-react-native/blob/v11.5.1/package/src/components/sources/raster-source/RasterSource.tsx)
supports XYZ raster templates, 256px tile size, zoom limits and attribution.
Its attribution string feeds an action sheet behind the map's attribution
button. Add an **always-visible**, readable, accessible copyright link over or
directly adjoining the map, showing `© OpenStreetMap contributors`, opening
`https://www.openstreetmap.org/copyright` via existing Linking. Keep the native
attribution/source metadata as well. Avoid overlap with booking sheets, controls
or system insets at small widths and large fonts. No new permission is needed.

Use a local style-spec object with one raster source at
`https://tile.openstreetmap.org/{z}/{x}/{y}.png`, tileSize 256, source maxzoom 19,
and a raster layer; no remote glyph/style/sprite service is needed for this
basemap. Stop markers remain an independent allowlisted GeoJSON source. This
adds no driver telemetry, road-route geometry, ETA or fare calculation.

## 4. Existing admin precedent and actual service obligations

The repository's `artifacts/mockup-sandbox/src/admin/StopMapPicker.tsx` uses the
same HTTPS raster template, Leaflet's visible attribution and a tile-error
fallback. Browser HTTP identity, Referer and cache behavior differ from native;
admin success therefore cannot prove the Android/iOS path. The existing admin
label says OpenStreetMap; native should use the explicit contributors label.

[OSMF tile policy, checked 2026-11-15](https://operations.osmfoundation.org/policies/tiles/)
requires identifiable requests, visible attribution and respecting server cache
metadata. Generic SDK identities, cache bypass, bulk/offline acquisition and
headless public-tile scans are disallowed. Test against controlled fixtures;
normal human viewing is the relevant permitted use. There is no service SLA.
Keep credentials, phone numbers, order IDs and precise GPS out of tile request
headers/URLs. IP and requested tile areas still reveal approximate viewing
location, so do not describe this as zero data disclosure.

## 5. Smallest verification plan, with explicit limits

1. **Now, without SDK install/build:** review exact tagged API/source paths
   above and pure-test a future policy/config builder for strict host matching,
   no API credentials, stable public identity, fixed raster parameters and link
   metadata. Such JS tests are prerequisite evidence only, not native proof.
2. **When a native artifact is authorized and readiness gates permit:** use a
   controlled reachable tile fixture with existing trusted network/debug policy
   (do not relax TLS, add permissions or disable protections). Record source
   SHA, MapLibre wrapper/native versions and merged manifest. Capture the first
   and later requests from actual Android and iOS separately, including headers.
3. Fixture returns a tiny known PNG and Cache-Control max-age with ETag; revisit
   the identical viewport before expiry, after screen remount and process
   restart. Assert no redundant payload download before expiry, then conditional
   revalidation/304 handling after expiry. Include Last-Modified-only and
   server-failure cases. Capture counts, header values and bytes, not screenshots
   alone. Test persistent cache without OfflineManager calls.
4. Verify host scoping and no app secrets on tile traffic; repeated mounts must
   not stack transforms. No tile URL cache busting, default no-cache, unexpected
   bulk look-ahead or background viewport fetches. Do not automate this scenario
   against public OSM infrastructure.
5. Actual native UI evidence: copyright text/link visible without tapping at
   narrow widths, light/dark UI and large fonts; selection/list fallback works
   with tile failures. Any public-source human smoke follows successful fixture
   validation and obeys current policy. Neither mocks nor APK119 establishes
   acceptance for a newly introduced module.

**Residual blockers:** native first-request ordering, cache persistence/capacity,
prefetch bounds and actual attribution layout are UNVERIFIED. Existing build
authorization/90% heavy-E2E gate still applies. No claim of ongoing background
work, successful native acceptance or production-ready tile hosting follows.
