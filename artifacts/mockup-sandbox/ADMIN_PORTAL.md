# TezJet — first working admin web screen

The existing React/Vite `@workspace/mockup-sandbox` now has a functional, **read-only** route `/admin` (in addition to the existing mockup previews). It reads the real passenger and driver directories via the protected TezJet API. This is a development-stage admin UI; it is **not** an independently deployed production admin app.

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
- No driver approvals, order cancellation, pitak updates, fare editing, or mutations in this first screen.
- Vite's development server proxies same-origin `/api` requests to the backend. **Production builds do not include Vite's dev proxy.** An operator must configure an HTTPS reverse proxy or equivalent same-origin API routing before deployment. Serve the admin panel only over HTTPS with proper access controls, an appropriate CSP, and restricted admin credentials.
- This UI has not been acceptance-tested in a mobile browser or against a public production backend; CI typecheck/build is not full end-to-end testing.
- The original TezJet section-9 task for an administrative user directory should be marked complete only after independent UI/browser acceptance with the real API, not merely when this PR merges.
