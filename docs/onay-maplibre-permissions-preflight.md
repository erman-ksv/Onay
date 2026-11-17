# Native MapLibre permission decision and controlled fixture entry

Measured investigation: 2026-11-15 04:30–04:33 UTC and resumed 08:58–09:02 UTC.
Continues the existing Maps plan. **SDK addition BLOCKED: two known new Android
permissions require the owner's decision.** No SDK install, grant, exclusion,
app/workflow edit, build or native test was performed. Complete future Gradle
resolution and merged APK remain UNVERIFIED.

## Preserved APK119 proof, without rebuilding

Read existing QA artifact **13621137108**, `onay-apk119-startup-android-qa`, from
[run 42488949212](https://github.com/erman-ksv/Onay/actions/runs/42488949212).
Its ZIP SHA256 was verified against GitHub's artifact digest. The artifact's
`badging-aapt2.txt` contains the actual compiled APK's package, uses-permissions,
features and SDK levels; `apk119-resource-verification.json` pins the checked APK
SHA256 to `ae8216170a72077fa589c22570544e369b4391b6f8da6f811f0f17885dfdb06f`.
The existing workflow pins that original artifact to source
`e61c32b6ec09fd73cb0f49e71211020a6ce1c1e9` from
[run 42486987509](https://github.com/erman-ksv/Onay/actions/runs/42486987509).
No new claim of inspecting freshly downloaded APK bytes is made.

APK119 has minSdk **24**, targetSdk **36**, INTERNET, foreground coarse/fine
location, SYSTEM_ALERT_WINDOW, VIBRATE, READ/WRITE_EXTERNAL_STORAGE and its
dynamic-receiver permission. It has **neither** ACCESS_NETWORK_STATE **nor**
ACCESS_WIFI_STATE. Its reported features are faketouch, location and portrait.
The hashed evidence and extracted sets are in
`evidence/onay-maplibre-permissions.json`; no signed download URL is retained.

## Published native AAR changes the wrapper-only conclusion

Inspected the published
[OpenGL 13.6.1 AAR](https://repo.maven.apache.org/maven2/org/maplibre/gl/android-sdk-opengl/13.6.1/android-sdk-opengl-13.6.1.aar)
manifest directly and pinned its SHA256 in the evidence file. Unlike the wrapper
manifest, it declares ACCESS_NETWORK_STATE **and** ACCESS_WIFI_STATE. Its
[POM](https://repo.maven.apache.org/maven2/org/maplibre/gl/android-sdk-opengl/13.6.1/android-sdk-opengl-13.6.1.pom)
and wrapper's [tagged Gradle file](https://github.com/maplibre/maplibre-react-native/blob/v11.5.1/package/android/build.gradle)
establish this as the default native dependency. Old android-sdk 11.3.0 plugin
transitives are explicitly excluded by the wrapper; do not count them as a
second selected native engine.

| Known delta vs APK119 | Purpose/source evidence | Decision boundary |
| --- | --- | --- |
| `android.permission.ACCESS_NETWORK_STATE` | Native connectivity state/reachability. `MapView` initializes reachability through `MapLibre.isConnected()`; `ConnectivityReceiver.isNetworkActive()` calls `ConnectivityManager.getActiveNetworkInfo()` without a local SecurityException catch. | Removing it can break map initialization/connectivity. No safe exclusion is proven. |
| `android.permission.ACCESS_WIFI_STATE` | Declared by the native AAR; Android classifies it as Wi-Fi state access. A classes.jar scan found no WifiManager/getWifiState/getConnectionInfo references in that AAR, so a precise ONAY runtime need is **not established**. | Supplier declaration still adds a permission. Absence of these strings is not proof across JNI/transitives or final graph; do not remove it speculatively. |
| `android.hardware.wifi`, `required=false` | Native manifest explicitly marks Wi-Fi hardware optional. | No new required Wi-Fi hardware restriction in the inspected manifest. Final merged features still need checking. |
| minSdk | Native AAR 23; wrapper fallback 24; APK119 24. | No increase implied by these inspected inputs, but selected transitive graph/actual generated app must confirm. |
| OpenGL/background/storage | No required OpenGL feature, background location, foreground service or storage permission in the seven inspected AAR manifests. | This is scoped manifest evidence, not proof of all future resolved dependencies, runtime GPU support, or background behavior. |

Other inspected AARs: annotation/scalebar 3.0.2 and gestures 0.0.4 (minSdk21),
fragment 1.8.9/appcompat 1.7.1 (21), vectordrawable 1.2.0 (19); none declares
permissions/features. Kotlin/OkHttp/Turf JARs do not supply Android manifests.
Remaining AndroidX transitive conflict resolution against ONAY is not executed;
the final merge report is mandatory before acceptance. Do not convert the scoped
finding into a claim that the complete future permission list is verified.

Callsite sources:
[ConnectivityReceiver.java](https://github.com/maplibre/maplibre-native/blob/android-v13.6.1/platform/android/MapLibreAndroid/src/main/java/org/maplibre/android/net/ConnectivityReceiver.java),
[MapView.java](https://github.com/maplibre/maplibre-native/blob/android-v13.6.1/platform/android/MapLibreAndroid/src/main/java/org/maplibre/android/maps/MapView.java),
[MapLibre.java](https://github.com/maplibre/maplibre-native/blob/android-v13.6.1/platform/android/MapLibreAndroid/src/main/java/org/maplibre/android/MapLibre.java).

## Concrete owner review proposal

Approve or decline adding **only ACCESS_NETWORK_STATE and ACCESS_WIFI_STATE**
through the reviewed pinned native MapLibre dependency for foreground map
rendering. These are normally install-time Android permissions rather than new
foreground location prompts, but the owner's rule covers any new permissions.
No Wi-Fi scanning feature, background location, new service/storage permission,
Google engine, paid provider or new secret is part of the proposal.

If approved, first generate and review the merged manifest/dependency report in
the authorized isolated validation step. Compare it against the pinned APK119
baseline; any additional new permission requires a separate decision. Preserve
existing dispatch/auth/GPS checks. Only then advance to the applicable authorized
native build/test boundary. If declined, leave native SDK integration blocked;
do not use `tools:node="remove"` or force-connected overrides as an untested
workaround. A reduced-permission variant would require a separate source-backed
design plus actual initialization, reconnect, location and regression tests.

## Smallest fixture entry using existing tools, not deferred E2E tooling

The existing native workflows already use Python stdlib, Android SDK `aapt2`,
ADB and UIAutomator XML/screenshots via `scripts/onay-android-apk-smoke.py` and
`reactivecircus/android-emulator-runner@v2`. Reuse those after authorization and
readiness gates; no Maestro/Appium/Detox or new heavy tooling is proposed.
Current native tests are Android-only: no iOS runner or iOS evidence is implied.

1. Future debug-only fixture entry must reuse the **actual same native map
   component**, with explicit static stop fixtures and no API/auth/driver data.
   A dedicated compiled QA flag and guarded Expo route such as
   `tezjet://qa/map-native` can expose it only in a diagnostic build. It must not
   replace the real booking screen or add networking to the existing isolated
   offline-demo path. The route/flag does not exist today; adding it is a future
   small app change requiring normal review, not a claimed available entry.
2. A Python `ThreadingHTTPServer` fixture serves a tiny fixed PNG, bounded XYZ
   paths, ETag/Last-Modified, controlled Cache-Control and request/byte receipts.
   Use `adb reverse tcp:PORT tcp:PORT` for device-local host access. First inspect
   the actual diagnostic APK network security configuration with existing aapt2:
   do not assume localhost HTTP is allowed. If current debug policy disallows
   it, use an already authorized trusted HTTPS fixture if available; otherwise
   mark transport BLOCKED. Do not loosen TLS/cleartext policy or add secrets to
   make this test run. No such HTTPS endpoint is confirmed in this task.
3. Before map mount, install the fixture-host scoped ONAY User-Agent transform;
   actual first request must carry it. Match production-host policy separately
   in pure tests; never rewrite public OSM traffic during an automated test.
   Cold launch via existing ADB MainActivity/VIEW intent, wait for the guarded
   fixture testID, and record raw fixture headers/counts. JS mocks cannot prove
   native registration ordering.
4. Revisit identical bounded view before expiry, remount screen and force-stop/
   restart **without** `pm clear`/reinstall/cache invalidation. Require fresh
   cache reuse then conditional request/304 after a short fixture expiry; test
   Last-Modified-only and failure responses. Assert byte counts and persistence.
   Receipt identifies source/build/dependency versions and exact scenario; tiny
   fixture TTL is not a production cache override.
5. One bounded gesture via ADB can check requested tile coordinates/zoom ranges
   and unexpected background look-ahead against a declared fixture budget.
   Use only the local fixture, never public tile sweeps. Visible copyright text
   must appear in UI XML plus screenshot at narrow width/light-dark/large font;
   a screenshot alone is not proof of cache or interactivity. Failures leave
   list controls available. Retain source/hash/native artifact identity.
6. Keep existing APK119 verification unchanged and reuse its evidence; it cannot
   execute a new SDK/fixture entry. No new native build or heavy test is run now.
   Whether this bounded native check may run before the owner's heavy-E2E gate
   must be stated by the Orchestrator; this plan does not silently waive it.

Status: owner permission decision **PENDING**, SDK addition **BLOCKED**, complete
merged manifest and fixture runtime **UNVERIFIED**. Tests in this task are
evidence consistency checks only; no new native functionality is DONE.
