# No suitable driver: scoped 6.6 backend acceptance

A new configured-line order may be created only when the server can atomically reserve an eligible driver's offer slot and the requested seats. Availability displayed earlier is advisory. It creates neither a booking nor a seat reservation and cannot authorize a later booking after conditions change.

## Ordinary configured orders

`GET /api/orders/route/availability` returns the current `available`, `eligible_driver_count`, server fare and offer timeout. A valid route may still return a fare with `available: false`. The passenger should present the lack of suitable drivers and use the result of the eventual booking request as authoritative.

`POST /api/orders/route` repeats selection under PostgreSQL locks. The driver must belong to the current route/direction and remain approved, in a permitted queue phase, without another pending offer, and have enough available seats. The configured FIFO remains in force. An eligible opposite-direction or unrelated car is not a fallback.

When no candidate remains, the API returns `409 NO_DRIVERS`. The transaction inserts no new order and does not debit seats or rewrite any queue. Invalid route selections, stale route versions, invalid pickup points and authentication failures retain their own errors; they are not silently treated as a successful booking.

The creation transaction locks candidate queues, then users, then the live route. Selection is rechecked after lock waits. If the last driver's queue entry is deleted first, the request fails without an order. If booking reserves the driver first, a simultaneous leave request fails with `409 ACTIVE_ORDER` and the single valid booking retains its reservation. A driver whose approval was revoked before the user lock is acquired cannot be selected from an earlier availability result.

Ordinary booking passes through GPS middleware before the store. A rejected request may still update the passenger's valid telemetry. The invariant is no new order and no seat/queue mutation, rather than no database writes of any kind.

## External pickup

`POST /api/orders/external/quote` first selects eligible collecting enrollments in the requested direction, then evaluates road reachability and the administrator's permitted pickup time. No eligible or reachable candidate returns `409 NO_DRIVERS`; quoting never creates an order or reserves seats. A missing/failed road provider produces `503 ROUTING_UNAVAILABLE` without a booking or straight-line billing fallback. See [external pickup](external-pickup.md).

An earlier successful quote still does not reserve a driver. `POST /api/orders/external/confirm` locks and rechecks the current enrollment, approval, route/policy, GPS freshness, seat balance and pending-offer ownership. If eligibility has changed, a controlled error such as `409 PICKUP_QUOTE_CHANGED` or `409 QUOTE_CHANGED` rejects the new booking. Its private temporary order envelope rolls back; no orphan order or new reservation remains.

Changing the candidate requires a fresh quote and passenger consent. Lack of drivers does not transfer an external reservation at an unapproved price.

## Existing orders and receipts

This prohibition concerns creation of a new order. An already created ordinary order may legitimately remain `searching` after refusal or expiry exhausts its lane; a later suitable driver may receive it. An existing external order may wait for a new passenger-approved price.

Replaying a successfully confirmed quote is an idempotent receipt: it returns the same order without creating or reserving another one. That remains valid when the driver is later unavailable. Cancellation and completion of an accepted trip also remain available independently of whether another driver could serve a new order.

## Evidence and limits

The existing integration suite covers empty or unsuitable queues, both directions, configured intermediate segments, insufficient seats, a full collecting car, a pending offer, departed drivers, current route versions, external reachability, invalidated quotes, and competing bookings. The focused 6.6 regressions add actual HTTP requests overlapping a PostgreSQL queue leave and an observed selected-driver user-row wait with approval revocation after positive availability. These tests retain the production HTTP app, durable adapters, real row locks and normal validation.

The application already implements this rule; this stage supplies the missing acceptance evidence and documents its contract. It does not implement mobile button states or a new passenger screen. Frontend work awaits the user's mockup. Physical GPS, Android/iPhone and production road-provider deployment remain separate acceptance.
