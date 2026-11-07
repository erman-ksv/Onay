# Offline UI preview

The owner explicitly requested a separate demo without SMS **and without a
server** on 2026-11-07. This is a UI preview, not authentication and not a
replacement for API-backed acceptance tests.

In the preview APK, choose **Посмотреть без SMS** on the login screen. The
selected passenger/driver role opens directly. The persistent **ДЕМО ONAY**
banner explains that data is illustrative and no real orders are sent. Both
roles, themes, booking examples, a local ride lifecycle, history and profile
can be explored. **Выйти из демо** returns to ordinary authentication.

`OnayDemoApp` mounts separately from `LiveOnayApp`. Its reducer and fixtures
are in `lib/onay-demo.ts`; examples use `onay-demo-*` IDs and route labels
prefixed with ДЕМО. It has no API/auth client, token, storage or Socket.IO
calls. State is discarded when the preview tree unmounts. Real OTP, role
approval, queues, reservations and backend rules are unchanged.

Ordinary builds default to `extra.onayDemoPreview=false` and expose no demo
entry. To build the requested debug preview, dispatch `mobile-ci.yml` on the
PR110 branch with **build_apk=true** and **demo_preview=true**. The workflow
clears the baked API URL for that preview, enables `ONAY_DEMO_PREVIEW=true`,
and uploads **onay-android-demo-apk** with a public source receipt recording
`offlineDemoPreview=true`. VersionCode is 111, preserving `uz.tezjet.app` so
the new preview can update versionCode110. This does not merge into main. Exports of different build modes use `--clear`
to prevent Metro from reusing the previous mode's Constants manifest.

The browser workflow separately exports ordinary and demo builds. Its offline
QA blocks API calls, asserts zero demo requests/sockets, checks both roles,
local lifecycle, navigation/themes/320–390px, confirms no token was created,
and verifies exit/restart discard changes. Ordinary builds are tested without
a demo entry. Existing API/real-browser regressions remain enabled.

Use the demo for viewing screens. It does not verify real SMS, phone GPS,
production payments, real dispatch or physical Android behavior. It does not
change the confirmed 96/151 implementation count or establish 1:1 visual
acceptance. No VPS or live SMS is required or authorized by this request.
