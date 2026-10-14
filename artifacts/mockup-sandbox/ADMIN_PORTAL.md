# TezJet — admin web portal

The existing React/Vite `@workspace/mockup-sandbox` has a functional route `/admin` (in addition to the existing mockup previews). It reads the real passenger and driver directories and configures route stops and endpoint pitaks through the protected TezJet API. This is a development-stage admin UI; it is **not** an independently deployed production admin app.

## Local setup

1. Set up the TezJet API server and PostgreSQL as described in `../api-server/README.md`, and set `ADMIN_PHONE` to the authorized administrator's phone in the **API backend**, never in frontend code.
2. Start the API at `http://127.0.0.1:5000` with the existing API startup script.
3. Start this Vite app with its existing required environment settings: `PORT=5173 BASE_PATH=/ pnpm --filter @workspace/mockup-sandbox dev`. If the backend is not running on port 5000, set `API_PROXY_TARGET=http://127.0.0.1:YOUR_API_PORT` for the **Vite process only**.
4. Open `http://127.0.0.1:5173/admin`.
5. Enter the configured admin phone, display name, and OTP code. The server may return a `demo_code` **only outside production**; the UI displays it only when present in the API response. In production an actual SMS provider is still required.
6. The admin session bearer token is held only in React component memory. It is not saved to localStorage, cookies, or the URL, and it is cleared on page reload/exit. The logout action calls the existing backend session invalidation endpoint.

## Features and limitations

- Secure **API-side** admin role authorization for lists of passengers and drivers, with role/status badges.
- Search directory by name, phone or ID; manual reload; responsive UI. Data is retrieved from `GET /api/admin/passengers` and `GET /api/admin/drivers`.
- The separate **Маршруты и остановки** navigation loads the real route catalog with `GET /api/admin/routes` and the selected route with `GET /api/admin/routes/:id`. The existing passenger/driver directory remains available.
- Create a route by name using `POST /api/admin/routes`; the server supplies its UUID, active state and default fare (500 KZT per stop). This screen does not edit fares.
- Add, edit, remove and move stops up/down. Each stop has a code, name, latitude and longitude; intermediate stops can have both coordinates blank. Existing stop IDs are preserved; new IDs are assigned by the server. Array order becomes canonical sequence/position 1..N.
- **Выбрать на карте** opens an inline Leaflet 1.9.4 picker with real OpenStreetMap tiles and attribution. Pan, zoom and click a point, then click **Использовать эту точку** to fill that stop's draft coordinates. **Закрыть карту** or Escape leaves the draft unchanged. The map starts at the stop's coordinates, another configured route stop, or a world view if neither exists; the initial view never supplies coordinates automatically. Arrow-key panning and **Выбрать центр карты** support keyboard selection; manual coordinate fields remain available. The picker requests no device location and does not save until the existing route save action. OSM tiles require browser internet access; if loading fails, coordinates can still be entered manually.
- Enable **Настроить питаки A/B**, select the first stop as A and the last as B, and enter an integer radius from 10 to 5000 metres. Both endpoints need coordinates and must differ. Codes are trimmed and normalized to uppercase; duplicate codes, incomplete coordinate pairs and nonfinite/out-of-bounds values are rejected. A route can be saved as a draft without pitaks; disabling the checkbox clears an existing pitak configuration on save.
- **Сохранить остановки и питаки** sends one full `PUT /api/admin/routes/:id/layout` with `expected_updated_at`, stops and optional pitaks. Success is shown only after the server accepts and returns the saved route. Errors retain the draft. A `409 ROUTE_CHANGED` keeps edits visible and blocks another save until an explicit reload; the UI explains that reload replaces the draft before doing so. Refreshing the catalog and late GET responses cannot overwrite edits. Switching routes with edits also requires explicit draft replacement. Section navigation retains the in-memory draft.
- No driver approvals, order cancellation, fare editing, matching, GPS tracking or queue operations are added by the route layout screen.
- Vite's development server proxies same-origin `/api` requests to the backend. **Production builds do not include Vite's dev proxy.** An operator must configure an HTTPS reverse proxy or equivalent same-origin API routing before deployment. Serve the admin panel only over HTTPS with proper access controls, an appropriate CSP, and restricted admin credentials.
- A local typecheck/build does not establish acceptance against a public production backend; route API behavior and browser checks should be verified in the operator's target environment before rollout.

