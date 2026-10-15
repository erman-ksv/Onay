# External pickup feeding a configured line (6.3)

This is the backend/API scenario for a passenger outside an origin pitak. The passenger selects a configured direction and destination, receives a road-based pickup quote, then confirms that exact driver and price. Drivers use the opt-in `/api/queue/line` enrollment. The existing line FIFO, ordinary legacy orders and already accepted trips retain their own rules.

## Administrator policy

`PUT /api/admin/routes/:routeId/external-pickup` requires an administrator and a complete body:

```json
{
  "expected_updated_at": "the-current-route-updatedAt",
  "settings": {
    "enabled": true,
    "service_radius_meters": 5000,
    "price_per_km_kzt": 100,
    "gps_max_age_seconds": 120,
    "quote_ttl_seconds": 60,
    "pickup_grace_seconds": 300,
    "max_pickup_seconds": 3600,
    "fare_rounding": "ceil_kzt"
  }
}
```

Numbers above are an API example, not a configured production tariff or area. There are no implicit policy/rate defaults. The circular service area is centered on pitak A for A→B and pitak B for B→A. The server requires all settings, checks their bounds and rejects stale `expected_updated_at`. The updated route/version is returned. Set the complete policy's `enabled` to false to disable new external quotes.

Configure policy before drivers save the new route version and enroll. Policy/layout/price changes advance the route version and invalidate unaccepted quotes/offers; affected drivers must reload and re-enroll when idle. Accepted trips keep their stored agreement. A waiting order using a superseded route version requires cancellation and a new explicit route selection, rather than silently moving to a changed route.

## Road routing

Set `TEZJET_OSRM_URL` to an operator-controlled OSRM-compatible base URL. It must support the [OSRM Table service](https://project-osrm.org/docs/v5.24.0/api/#table-service) with distance and duration annotations. No provider is selected automatically, and no straight-line billing fallback is used. A missing, failed, redirected, malformed or timed-out provider produces a controlled `503 ROUTING_UNAVAILABLE` without creating an order or reserving seats.

The service evaluates all eligible drivers, in batches of up to 50 with two concurrent requests, up to 500 candidates. Larger fleets fail explicitly rather than being truncated. Each request has a five-second deadline and the entire operation ten seconds. Responses are bounded to 1 MiB. Unreachable matrix entries are excluded; failure of a batch fails the whole quotation. Distances are those of the provider's fastest driving routes, not shortest-path guarantees or live traffic predictions. Raw road metres determine the nearest eligible driver; ties use FIFO time, then driver ID.

Only collecting drivers in the selected route/direction with free seats, no pending offer, current approval and a recent server-received location qualify. Boarding/accepted orders can coexist with the next offer. No driver who has departed the line is selected by this feature.

## Passenger quote and confirmation

`POST /api/orders/external/quote`:

```json
{
  "route_id": "route-id",
  "direction": "a_to_b",
  "expected_updated_at": "the-current-route-updatedAt",
  "destination_stop_id": "optional-configured-stop-id",
  "pickup_location": { "lat": 42.905, "lng": 71.31 },
  "pickup_address": "Optional meeting instructions",
  "seats": 2
}
```

The target is separate from the requesting device's GPS and never rewrites the passenger's location. Destination defaults to the opposite endpoint; the line fare is origin→destination. The target must be inside the configured external service area. The response contains `quote_token` and `quote` with the driver ID, base fare, road pickup distance/time, surcharge, total, rate, rounding and expiry. Quoting alone creates no order and reserves no seats.

The payable pickup distance is one way from the selected driver's sampled current location to the passenger. Provider distance/time are rounded upward to whole metres/seconds after choosing the driver. The surcharge is `whole metres × administrator KZT/km ÷ 1000`, using exact integer arithmetic. `ceil_kzt` rounds a positive fractional KZT up; `nearest_kzt` rounds to nearest KZT, with positive halves up. Total is line fare plus surcharge. The original per-stop tariff/currency remains KZT.

`POST /api/orders/external/confirm` accepts only `{ "quote_token": "..." }`. A new reservation returns `201`; an applied quote replay or confirmed new quote for the same order returns `200`, with `{order, created, changed}`. Signed quotes have a purpose-derived key and audience distinct from access tokens. Exact driver coordinates and telephone numbers are not embedded in the token; its coordinate fingerprint is keyed. Quotes bind passenger/session, route/version, target, seats, driver/enrollment, policy, road result, price and expiry.

Confirmation locks and rechecks the current order, driver queue, users and route. Driver position must still match the quote; identical-coordinate heartbeats do not invalidate it. After passenger confirmation the agreed price remains fixed for the offer period (60 seconds by default): normal driver movement does not increase it. Acceptance still requires fresh telemetry, current enrollment and approval, valid route/policy and ownership of the single pending reservation.

## Refusal, timeout and a new price

Refusal, offer timeout or invalidation releases exactly the owned reservation. The same order becomes `searching` with `external_pickup.requires_price_confirmation: true`. The server never reserves another driver at an unconfirmed new price. The passenger screen can request the next quote with only `{ "order_id": "existing-order-id" }` at the quote endpoint, then confirm its returned token. The target, destination, seats and route selection come from the existing order; clients cannot edit them through repricing. Previously attempted drivers are excluded, so the next quote selects the next nearest eligible driver. No drivers yields `409 NO_DRIVERS` and no reservation.

Each repricing quote binds the order's monotonic version and attempt history. Concurrent or old confirmations cannot replace a newer agreement. The initial quote UUID is also the order's permanent primary key: retrying it returns the current same-owner order without another reservation, including after repricing or quote expiry. A correctly signed expired quote cannot create a new order or change a price.

The initial transaction inserts a private, uncommitted order envelope with no driver/offer fields, then acquires locks in order→queue→sorted users→route order. Failure rolls everything back. Road HTTP calls never occur under database locks. Existing payload columns persist settings and accepted snapshots; no new table or migration is needed after migration 0006 from PR #42.

## Pickup, seats and departure

Acceptance starts the pickup deadline using quoted road seconds plus the administrator's grace. A candidate exceeding the maximum pickup time is excluded; the server does not shorten the required drive to fit that maximum. The accept response has `seat_lock_minutes: null`, `pickup_wait_seconds` and the order's actual `seat_lock_expires_at` instead of claiming a fixed seven minutes.

External pickup follows the assigned order's arrival, boarding, waiting and completion/cancellation actions. The driver can leave and return to the pitak without losing FIFO priority. Boarding clears only this order's pickup deadline and does not debit seats again. A boarded passenger can wait for the car to fill. Only manual `/api/queue/depart` leaves the line; unboarded external passengers block departure. Empty, partial and full departures otherwise retain PR #42 behavior.

Pickup expiry releases only that order's seats and requires a new passenger-approved quote. Cancellation and completion credit seats once; neither sends a collecting car out of FIFO nor restores a departed car to it. Accepted target and fare remain unchanged if the route/policy is later edited or deleted.

## Acceptance boundary

The integration suite exercises actual Express HTTP, PostgreSQL storage/row locks, two adapters and real HTTP requests to a controlled OSRM-protocol fixture. It covers road ranking, policy, price consent, expiry, replay, actor/session checks, capacity, restart visibility and concurrent mutations. A fixture validates the provider contract and failure paths; it does not establish production map coverage or live road/GPS accuracy.

Mobile screens await the user's mockup. Production routing hosting/configuration, real GPS and physical Android/iPhone acceptance remain deployment/device work. Negotiated ordinary rides like inDrive and accepting new compatible passengers after departure belong to separate stages.
