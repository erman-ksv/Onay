# Configured-route booking recovery

An HTTP timeout does not establish whether a booking committed. A passenger's
booking intent must survive app and API restarts without reserving seats twice.

## API contract

- `GET /api/orders/route/request-key` requires passenger authentication and returns
  `{ "request_key": "<UUID v4>" }`. This allocates no seats or database receipt.
  Responses cannot be cached. It avoids a new native randomness dependency.
- `POST /api/orders/route` accepts the optional `Idempotency-Key` header. Keys are
  UUID v4 strings, normalized to lowercase and scoped to the passenger. Existing
  clients without this header keep their previous response contract.
- Initial success returns `201` with `order`, `offer`, and `replayed: false`.
  Repeating the same intent returns the current order with `200` and
  `replayed: true`. It does not reserve seats or emit offer notifications again.
- The intent binds the selected route, direction, catalog version, stop selectors
  and seats. GPS may be refreshed without changing the intent. Changing any bound
  field with an existing key returns `409 IDEMPOTENCY_CONFLICT`.
- `GET /api/orders/route/requests/:requestKey` returns `{ order }` for the current
  passenger only. Unknown requests return `404 ORDER_REQUEST_NOT_FOUND`; a
  missing order behind an existing receipt returns `409 ORDER_RECOVERY_REQUIRED`.
  Recovery rechecks current role/session and does not change GPS or reprice trips.

Every new booking still passes body, GPS, route, driver approval, FIFO and seat
checks. Existing bookings replay before GPS/catalog checks, including cancelled
or completed orders, and preserve their agreed fare.

## Persistence and concurrency

Migration `0007_route_order_requests` adds passenger-scoped receipts. A transaction
advisory lock serializes identical passenger/key pairs across API instances.
Receipt, order and seat reservation commit together. No-driver results retain no
receipt. Existing queue/user/route lock ordering remains unchanged. Receipts have
no deletion cascade or automatic expiry: an orphan must block a duplicate rather
than silently create another booking.

The middleware lookup is advisory. Concurrent HTTP requests can still encounter
GPS validation before allocation when both initially observe no receipt. The
store transaction guarantees at most one order/reservation for a committed key;
recovery lookup resolves a committed booking after such an error.

## Mobile behavior

The passenger screen obtains a key and persists it before its first booking POST.
Storage contains only status, order ID and request key, separated by endpoint and
passenger. It stores no token, passenger name or coordinates. A lost response can
be resolved with **Проверить статус заказа**, even when route loading fails.
The exact confirmed order must appear in the refreshed list before unlocking.

A recovery `404`, timeout, invalid response, server error or generic conflict does
not unlock a fresh booking or automatically resubmit a POST. Earlier POSTs might
still commit. Old/corrupt records without a usable key remain blocked for review;
this change cannot reconstruct intent IDs that were never stored. Explicit known
pre-commit validation/no-driver failures may clear their attempt. A known exit
before the POST clears only its own unsent receipt.

Endpoint/session changes stop old-screen follow-up requests. The API helper keeps
the idempotency header while protecting the current Authorization header.

## Acceptance

Regression coverage includes both adapters, real PostgreSQL concurrency, restart,
authorization, fare preservation, terminal states, orphan receipts, HTTP GPS and
notification behavior, mobile persistence/reconciliation and header forwarding.
Deploy the database migration before enabling the new client. Android/iPhone
device tests with a running backend, physical GPS and real connection loss are
still required; bundle/APK builds do not replace those tests.
