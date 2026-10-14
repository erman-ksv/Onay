# TezJet API

TezJet is a rural taxi hailing backend with OTP registration, single-session JWT
authentication, an anti-fraud location gate, FIFO driver queuing, Point C seat
locks, Point D route pooling, and Socket.io realtime events.

## Natural-language addresses

TezJet can use the Google Gemini API to turn a phrase such as
`Корасув, рядом со школой` into a structured address:

- `POST /api/addresses/normalize`
  - Body: `{ "address": "..." }`
  - Requires a TezJet bearer token.
  - Returns normalized locality, street, house number, landmarks, optional
    coordinates, confidence, and uncertainty notes.

Passenger orders may also include `pickup_address`. The normalized result is
stored in the order as `pickup_address`, while `pickup_location` remains the
authoritative GPS coordinate and still passes the anti-fake GPS middleware.

Set `GEMINI_API_KEY` as a Replit Secret. The optional `GEMINI_MODEL` environment
variable overrides the default `gemini-3.6-flash` model. API keys are never
returned in responses or written to source files.

## Run

```bash
pnpm --filter @workspace/api-server run dev
```

The managed workflow supplies `PORT`. Set `SESSION_SECRET` for production. Storage selection is explicit:

- Tests use the in-memory adapter.
- Development uses in-memory storage by default. To test PostgreSQL, set `TEZJET_STORAGE_ADAPTER=postgres` and `DATABASE_URL`.
- Production refuses to start unless `TEZJET_STORAGE_ADAPTER=postgres` and `DATABASE_URL` are configured; it will not silently run with volatile in-memory data.

Provision the PostgreSQL database and apply the current Drizzle schema before enabling the PostgreSQL adapter:

```bash
pnpm --filter @workspace/db run push
```

CI provisions PostgreSQL, applies the Drizzle schema, runs the API regression scenarios against the PostgreSQL adapter, verifies that users and orders survive an API process restart, and tests concurrent duplicate acceptance of the same order. Offer assignment, reserved seats, acceptance, rejection, and cancellation use the store's transaction boundaries. Before production launch, complete deployment-specific security and load testing.

## Release scenario checks

Run the API regression scenarios from the workspace root:

```bash
pnpm test
```

The check builds the API, starts an isolated test server, and verifies OTP
registration and login session invalidation, FIFO driver queue behavior, Point
C seat locks and status transitions, Point D pooling, and Socket.io realtime
events. It uses development OTP responses and does not require external
services.

## Authentication

1. `POST /api/auth/request-otp`
   - Body: `{ "phone_number": "+7 777 123 45 67", "full_name": "...", "role": "passenger|driver", "locale": "kk|uz|ru" }`
   - Development responses include `demo_code`; production responses never expose the OTP.
2. `POST /api/auth/login` or `POST /api/auth/verify-otp`
   - Body: `{ "phone_number": "...", "code": "123456" }`
   - Every successful login increments the session version and invalidates all earlier JWTs.
3. Send `Authorization: Bearer <access_token>` to protected routes.

`PATCH /api/auth/profile` only accepts locale changes. `full_name` and
`phone_number` are locked after the first successful OTP registration.

## Queue and orders

- `GET /api/queue` — current FIFO queue, Pyatak zone and your position.
- `POST /api/queue/join` — driver joins within the configured Pyatak geofence.
- `PATCH /api/queue/location` — location update checked by anti-fake GPS middleware.
- `PATCH /api/queue/status` — `searching`, `picking_up`, `en_route_to_c`, `arrived_at_c`, `in_transit`.
- `GET /api/fares/stops?route_id=pyatak` — route-stop catalog and `price_per_stop`.
- `POST /api/fares/estimate` — calculate
  `ceil(abs(destination_position - pickup_position)) * price_per_stop`.
  It accepts `{ "route_id": "pyatak", "pickup_stop": "C",
  "destination_stop": "D" }` or the legacy `{ "route_stops": ["C", "D"] }`.
- `POST /api/orders` — passenger creates a Point C or Point D order. Optional
  `route_stops` uses the same route catalog; when omitted, the pickup point is
  used as the pickup and destination stop, with a minimum one-stop fare.
- `POST /api/orders/:orderId/accept` — the driver holding the live offer accepts; Point C gets a 7-minute seat lock.
- `POST /api/orders/:orderId/reject` — the driver holding the live offer rejects it, returning its reserved seats and offering the order to the next eligible driver.

One phone number can use passenger and driver modes. `POST /api/auth/switch-role`
with `{ "role": "passenger" }` or `{ "role": "driver" }` returns a new access
token and a user containing `active_role` and `roles`; previous tokens and
connected sessions are invalidated. A newly enabled driver awaits administrator
approval. Switching is blocked with `ROLE_BUSY` while an order is unfinished or
the driver is still in the queue. The driver must finish/cancel the trip and leave
the queue first. Switching never grants administrator access.
- `PATCH /api/orders/:orderId/status` — driver advances `en_route_to_c` → `arrived_at_c` → `in_transit` → `completed`.
- `POST /api/orders/:orderId/cancel` — passenger or assigned driver cancels. A driver with a pending offer must use `/reject`; `/cancel` returns HTTP 409 `USE_REJECT`.

Point C orders are offered to eligible drivers in FIFO order. A driver has at
most one pending offer, and the requested seats are reserved when the offer is
created. Rejection or timeout returns those seats once and advances to the next
eligible driver; acceptance keeps that reservation without subtracting seats a
second time. A driver's position does not need to be #1 after earlier drivers
have declined the same order. Stale acceptance and rejection return HTTP 409.

Point D orders are offered to the first eligible in-transit driver with enough seats.
Driver-facing order responses mask passenger phone numbers.

Orders expose `offered_driver_id` and `offer_expires_at` (Unix milliseconds).
When upgrading an existing PostgreSQL database, stop the previous API and run
`pnpm --filter @workspace/db run migrate` before starting the new API. Migration
`0001_order_offers` adds the pending reservation/deadline fields, reopens legacy
searching offers that have no deadline, and enforces one pending offer per driver.
Offers last 60 seconds by default; set `TEZJET_OFFER_TIMEOUT_SECONDS` to change
the duration. The server checks stored offer deadlines and seat locks on startup
and every second, so deadlines continue after a process restart. Queue joins,
departures, rejection, acceptance, cancellation, and status changes also trigger
dispatch. Passengers check `GET /api/orders/availability?pickup_point=C&seats=2`
before ordering; the response contains `available`, `eligible_driver_count`, and
`offer_timeout_seconds`. `POST /api/orders` creates the order and reserves its
first offer in one transaction. Without an eligible driver it returns HTTP 409
with error code `NO_DRIVERS` and does not persist an order. Existing searching
orders whose drivers all rejected remain waiting for a newly eligible driver.
Drivers cannot leave or reset their queue entry while an offer is pending.

`POST /api/orders/:orderId/offer-first-driver` is a compatibility endpoint for
Point D offers. It uses the same store dispatcher and cannot force an offer to
the requesting driver or extend a live offer deadline.

The default route has two stops, Point C and Point D, and a price of 500 KZT
per stop. Admins can change the price and stops at runtime through `/api/admin`.
Set `REQUIRE_DRIVER_APPROVAL=true` to block unapproved drivers from joining
the queue. Admin OTP registration is enabled only when `ADMIN_PHONE` is set.

### Admin API

Admin JWTs can manage the route catalog:

- `GET|POST /api/admin/routes`
  `GET` accepts optional `?active=true` or `?active=false`; omitted returns all routes, invalid values return HTTP 400. Does not modify routes.
- `GET /api/admin/routes/:routeId` — read one route and its configured stops (admin-only, 404 if absent).
- `PUT /api/admin/routes/:routeId/layout` — replace ordered stops and static pitaks A/B together (admin-only; contract below).
- `PATCH|DELETE /api/admin/routes/:routeId`
- `POST /api/admin/routes/:routeId/stops`
- `PATCH|DELETE /api/admin/routes/:routeId/stops/:stopId`
- `GET /api/admin/queue` — admin-only FIFO snapshot: driver ID, position, join time, status and available seats; never includes GPS, phone numbers, or private locks. Read-only.
- `GET /api/admin/drivers`
- `GET /api/admin/passengers` — admin-only list of accounts with passenger capability (including driver-mode accounts); includes personal data and must not be exposed publicly.
- `GET /api/admin/statistics/trips` — admin-only aggregate total, active, completed, cancelled and per-status trip counts. No personal data or revenue calculations.
- `GET /api/admin/orders` — admin-only read-only overview of all orders, including personal data. No order status changes or dispatch side effects.
  Optional `?status=active` selects nonterminal orders, `?status=all` selects all (default), and exact statuses `searching`, `en_route_to_c`, `arrived_at_c`, `in_transit`, `completed`, `cancelled` are supported. Invalid values return HTTP 400.
- `PATCH /api/admin/drivers/:driverId/approval` with
  `{ "status": "pending|approved|rejected" }`
- `GET /api/admin/queue-point` — read the current Pyatak center and 150-meter geofence.
- `PATCH /api/admin/queue-point` — update the center from the admin panel with
  `{ "lat": 41.3111, "lng": 69.2797 }` or `{ "center": { "lat": 41.3111, "lng": 69.2797 } }`.

The queue point update requires an admin JWT. Coordinates are validated before
being applied, and the new center is used immediately by driver queue joins,
location updates, queue status responses, and realtime queue events. The current
in-memory adapter keeps this setting until the API process restarts.

### Static route layout and pitaks A/B

Read the route first and send its exact `updatedAt` as `expected_updated_at`:

```json
{
  "expected_updated_at": "2026-10-14T12:00:00.000Z",
  "stops": [
    { "id": "existing-a-id", "code": "A", "name": "Pitak A", "location": { "lat": 41.3111, "lng": 69.2797 } },
    { "code": "M", "name": "Intermediate stop", "location": { "lat": 41.32, "lng": 69.29 } },
    { "id": "existing-b-id", "code": "B", "name": "Pitak B", "location": { "lat": 41.33, "lng": 69.3 } }
  ],
  "pitaks": { "a_stop_code": "A", "b_stop_code": "B", "radius_meters": 150 }
}
```

The response is `{ "route": ... }`, using the same camel-case route shape as
the route reads. Stops gain optional `location: { lat, lng, timestamp }`, with a
server timestamp for the static point. A configured route gains
`pitaks: { aStopCode, bStopCode, radiusMeters }`. These are catalog geometry and
do not change driver GPS checks, matching, queuing, or order dispatch.

The array order sets both `sequence` and `position` to `1..N`. Existing stop IDs
must belong to this route; omit an ID to create a stop with a server-generated
ID. Duplicate IDs or codes are rejected. Codes are trimmed, uppercased and
limited to 40 characters; names are trimmed and limited to 120 characters. A
layout has at most 1000 stops. Coordinates must be finite JSON numbers, with
latitude between -90 and 90 and longitude between -180 and 180. Pitaks A/B must
refer to distinct first/last stops that both have coordinates, and the radius
must be an integer between 10 and 5000 meters.

Omit `pitaks` to save a draft without configured endpoints; this removes any
previous pitaks configuration. An empty draft is accepted. The replacement
preserves route name, price, active state, creation time, and historical order
snapshots. PostgreSQL stores the layout in the existing route JSON payload;
no schema migration is needed.

A stale version returns HTTP 409 `ROUTE_CHANGED`; reload the route before
reviewing and retrying. Versions advance on every catalog mutation, including
multiple saves in the same millisecond. All route writers use the same row lock
in PostgreSQL to preserve concurrent layout and metadata changes. The older
stop endpoints reject deletion or code changes of configured pitaks, or changes
that move them away from the first/last positions, with HTTP 409
`ROUTE_LAYOUT_EDITOR_REQUIRED`; use the layout editor for those changes.

## FIFO queue and active-trip pooling

When a driver accepts an order that uses all remaining seats, the driver is
removed from the FIFO queue immediately. When the driver changes the order
status to `in_transit` (the "Go" action), the driver is removed from FIFO even
if seats remain available. The active-trip record keeps the remaining seats and
active order IDs, so Point D pooling can offer new passengers to that driver
without changing the FIFO order of drivers who are still waiting.

The current runnable adapter models the Redis design with an `inFifo` flag on
the queue entry. A Redis-backed adapter should map FIFO membership to a sorted
set and keep active-trip entries in a separate collection.

## Realtime and push-ready events

Socket.io connects to the same server with:

```js
io({ path: "/api/socket.io", auth: { token: accessToken } });
```

The server emits:

- `incoming_order` — `{ priority: "high", sound: "incoming_order.mp3", order }`
- `order:offer_withdrawn` — `{ order_id, order, updated_at }` sent to a driver whose pending offer ended
- `order:status`
- `queue:snapshot` — initial queue state on connection
- `queue:update`
- `queue:joined`, `queue:left`, `queue:status`, `queue:location`
- `queue:position` — private position update for each driver
- `queue:reordered` — emitted when FIFO ordering may have changed
- `queue:order_offer` — pending offer assignment, withdrawal, or reassignment changed the queue's reservations

Driver connections replay their current unexpired offer. Realtime events are
sent after storage commits. Socket delivery currently reaches clients connected
to the same API instance; a shared Socket.io adapter and a transactional event
outbox are needed for coordinated delivery across multiple API instances.

Use `GET /api/notifications/config` for client notification settings,
`POST /api/notifications/devices` to register a push token, and
`POST /api/notifications/test-alert` to verify the high-priority client path.

