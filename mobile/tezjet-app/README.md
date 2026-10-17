# TezJet Mobile

One native React Native + Expo app for Android and iOS, with passenger and driver modes on the same phone account.

## Configure the API

Open **Настройки сервера** in the app and enter the reachable HTTPS API origin, such as `https://api.your-domain.example`. The setting is saved on the device. Changing it clears the previous session before the app uses the new server; sign in again after changing servers. If removal of the saved token fails, the server change stops.

For a build-time default, copy `.env.example` to `.env` and set `EXPO_PUBLIC_API_URL`. The value may be omitted; the app then starts with server settings and disables sign-in until a server is configured. Only root URLs without credentials, paths, queries, or fragments are accepted. HTTP is allowed for local development with `localhost`, `127.0.0.1`, `10.0.2.2`, or `[::1]`. A physical phone needs a reachable HTTPS endpoint; `localhost` refers to the phone itself.

## Run locally

From this directory, run `pnpm install` and then `pnpm start`. Scan the Expo QR code with Expo Go for early UI testing. The API must be running and reachable from the device.

## Passenger mode

- Phone OTP sign-in.
- For normal A↔B orders choose an administrator-configured route and direction, verify current server availability and fare, then provide actual phone GPS at booking. This first mobile increment uses origin-pitak to opposite-pitak rides; intermediate stops and external pickups are separate UI work.
- Select 1–8 passengers.
- Create an order with pickup coordinates. The current API requires those coordinates, so order creation stops if location permission is declined.

## Driver mode

- A driver profile can be requested from the same phone account.
- New driver profiles remain pending until an administrator approves them.
- Approved drivers can join/leave the queue, update their location, receive incoming offers over Socket.IO, accept orders, and advance the trip status.
- Approved drivers can view administrator-configured routes, select A → B or B → A with actual endpoint names and ordered stops, and explicitly save the choice. The API restores the saved choice after sign-in or reload; changing servers or sessions loads that session's choice again before queue entry is available.
- Saved A → B choices join the administrator-configured pitak A; B → A choices join pitak B. The location button requests device coordinates and the server checks the actual endpoint radius. The exact saved route/direction/version accompanies the request; queue geometry is derived on the server. Enrollment and lane position survive reload. Exit the queue before changing the route.
- Configured A/B queue enrollment is separate from the legacy C/D order flow. Positions are counted per route and pitak. Configured drivers do not receive legacy orders. Passenger configured-route orders use /api/orders/route and configured FIFO dispatch; line collection and manual departure are separate mobile follow-up work. Clear a choice to use the existing legacy queue. Existing offers and trip controls continue to work.
- Route changes and clearing are unavailable while queued, on a trip, answering an offer, or performing another action. If an administrator changes a route during save, the app refreshes the catalog, keeps the route/direction draft, and requires another explicit save after reviewing the stops. An unavailable saved route remains visible until it is replaced or cleared.
- The API checks both seat capacity and whether the driver is at or demonstrably approaching the pickup. Merely being at another pickup point is not enough.
- Signed-in users switch modes through `POST /api/auth/switch-role`; the API returns a new token and preserves the account's roles and driver approval. No extra OTP is needed for an authenticated switch.
- Switching is blocked while a passenger trip is unfinished or the driver is in the queue or on a trip. Complete or cancel the trip and leave the queue first.

The API must include persistent account roles and the switch-role endpoint. Older API versions with a single immutable role do not support this flow. Pending or rejected driver profiles cannot join the queue or accept offers.

Orders refresh on reconnect, app resume, and a ten-second interval. Incoming Socket.IO updates received during a GET remain authoritative when its snapshot arrives. Offline failures keep the local token; an HTTP 401 clears the session. Offer accept/reject actions wait for the API result, and expired offers disappear.

## Builds and validation

Expo EAS can build an Android preview APK and an iOS binary. An Expo account is required; iOS distribution also requires Apple Developer membership. Store publication is a separate release step.

GitHub Actions installs dependencies, checks TypeScript and API/order regressions, exports Android/iOS bundles, generates the Android project, and assembles a debug APK with JavaScript embedded. Successful runs upload `tezjet-android-debug-apk`. The optional repository variable `TEZJET_API_URL` sets the default API for export and the APK; without it, configure the endpoint in the app.

The Expo web export (`pnpm exec expo export --platform web`) uses the same application and route picker for browser validation. React DOM and React Native Web are included for Expo 54; this remains the native mobile application with a browser test surface.

Build and export success must be checked on the current commit. Physical-device API connectivity, location permission behavior, Socket.IO events, background behavior, and iOS native compilation remain unverified until tested on suitable devices or runners. The API also needs a configured OTP delivery service for production sign-in; development responses may show a test code.
