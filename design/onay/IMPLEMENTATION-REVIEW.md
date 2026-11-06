# Onay V2: source, APK diagnosis and acceptance evidence

The pinned `Onay.html` is the published passenger/driver artifact fetched on
2026-11-06, not a newly invented design. `reference.json` records its URL and
SHA256 digests. Its embedded role documents and PNG logo are independently
verified by `scripts/onay-v2-browser-qa.py`. The admin design is excluded.
The reference is never imported into the application or used as API fixtures.

## Why the previous APK looked different

The APK in Actions run `42249940739` was built from **main**
`7dfc5b46f0efae217f6bd699bab8ac3e6bc5d6ee`, which does not contain PR110.
The PR head at the start of this correction was
`c0a94b18cea19ab01cc810a380bc63caf8c1c6da` on
`feat/artifact-auth-ui-v1`. They are different sources; Metro cache is not
needed to explain the installed old interface.

The PR also contained genuine gaps: unconfigured startup reached the legacy
renderer; booking forms appeared under the new home; the driver still used
the long legacy page; visible branding used a white JPEG instead of the
published transparent PNG. This correction addresses these paths and adds a
public source receipt to the APK artifact and source identity in About.

There is no evidence that Expo Router selected a second entry point. The app
uses `expo-router/entry`, `app/_layout.tsx`, and `app/index.tsx`. The APK must
keep applicationId `uz.tezjet.app`; V2 sets explicit versionCode **110**. A
greater versionCode identifies an upgrade, but source/bundle inspection and
screenshots are still required. Native debug JavaScript remains embedded by
the existing Gradle configuration; an active Metro is not required.

## Screen review (do not interpret green CI as pixel equivalence)

| Area | Correction | Remaining difference / limitation |
| --- | --- | --- |
| Entry / connection | Native V2 for missing API, invalid endpoint and lost profile; old auth renderer removed | Server setup is an operational app screen absent from the prototype |
| Phone / roles / OTP | Original transparent logo, native role controls, six OTP cells, loading/error guards, Android OTP Back handler | Required registration name/surname and real six-digit API challenge differ from demo-only sign-in |
| Passenger home / tabs | 430dp viewport, source icons and light/dark tokens, isolated booking page; no forms below home | Schematic is explicitly not GPS; existing settings access and API error states add controls |
| Route / stops / booking | Native full-screen entry, real route/direction/stop selection, themed cards and seat controls | API-required route/version/fare confirmation differs from the demo builder; deferred booking, whole-car booking and negotiated prices are unavailable |
| Active ride / driver details | Existing real order state, cancellation, driver API and status guards retained in V2 presentation | Prototype vehicle tracking map, animation and complete track/detail/rating flows are not implemented pixel for pixel |
| Trips / history | Separate native trips tab and actual API history; successful creation opens Trips | Final visual acceptance of all populated history/status cards remains open |
| Chats | Consistent native V2 tab and truthful unavailable state | No chat transport or messages API; demo conversations are not real functionality |
| Passenger profile / support / about | Original logo, actual version, themes, real identity and support email preserved | Personal data expands within profile; prototype support chat, legal pages and some settings are not implemented |
| Driver line | Native shell, schematic, actual car/seat summary, existing offers and trip controls | Real shift/queue/permission controls differ from the prototype; manual phone passengers are not supported |
| Driver queue / route | Independent queue tab, validated real API queue, separate route editor; approval guards retained | API exposes position/seats rather than all demo names, photos or vehicle metadata |
| Driver profile / vehicle | Native profile rows and separate vehicle editor, real approval and save behavior | Language and sound/vibration prototype settings have not been implemented |
| Driver history / navigation | Independent history tab, focus load, five responsive native tabs; logout clears navigation | Android hardware and populated history visual acceptance remain open |

These are **open acceptance differences**, not claims of 1:1 completion. Do
not label this APK a completed exact reproduction of every prototype screen.
Backend rules, production infrastructure and Agent Factory are unchanged.

## Reproducible verification

- Mobile TypeScript and the complete mobile regression suite.
- Workspace TypeScript, existing PostgreSQL API tests and bounded load in CI.
- Existing driver, passenger-stop and line-ride browser scripts retain their
  API, dispatch, recovery, capacity, conflict and authorization assertions.
  Only navigation helpers were adapted to the new independent pages.
- Regression: logout/re-login resets the driver tab to Line.
- Regression: closed/absent booking recovery refreshes orders without
  navigating away; only confirmed creation/recovery opens Trips.
- V2 browser script additionally checks the unconfigured APK entry, invalid
  endpoint, real UI OTP, both roles, navigation, themes/reload and 320/390px.
- The same script captures `actual-*.png` and `reference-*.png`, validates the
  pinned source hashes and saves `verification.json`. The existing browser
  workflow publishes these under the `driver-route-qa` artifact, `onay-v2/`.
- Browser plugin is unavailable in this environment; pinned Python
  Playwright Chromium is the documented fallback.

## Required manual acceptance

No Android device/emulator is available in this workspace. APK installation,
hardware Back, keyboard/IME, safe areas and system navigation bars, native
theme contrast, offline restart, physical GPS and an end-to-end two-device
trip are **not verified by browser screenshots**. Real SMS/HTTPS also remain
unverified. An unconfigured APK needs a reachable approved API endpoint;
this work does not deploy a server or send a real SMS.

PR110 stays Draft. No merge into main is authorized. The confirmed project
implementation count remains 96/151 (63.6%); redesign, tests and APK builds
do not add completed product tasks.
