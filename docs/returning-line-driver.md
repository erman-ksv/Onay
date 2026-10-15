# Returning to the current line: scoped 6.4 acceptance

This scenario follows the agreed collection rule: a driver enrolled at A for A→B can collect an external passenger and receive another ordinary A→B order while returning to A. The B→A case works symmetrically. The driver retains that enrollment and its FIFO time until explicitly pressing **Поехали**. The implementation already exists in the line-collection and external-pickup stores; this stage adds direct HTTP/PostgreSQL acceptance for their combined behavior.

## Preconditions and lifecycle

1. The administrator configures an active route and complete external-pickup policy. Road routing must be configured separately; see [external pickup](external-pickup.md).
2. An approved driver saves the current route/direction and enrolls through `POST /api/queue/line` at that direction's origin pitak. The server owns enrollment, capacity and FIFO time.
3. An external passenger requests a quote, approves its price, and the driver accepts the resulting offer. This reserves and then retains only that passenger's seats.
4. At pickup the driver records arrival and boarding. The passenger becomes `boarded_waiting`; boarding clears that passenger's pickup deadline and does not leave FIFO or debit seats again.
5. The driver sends validated location updates through `PATCH /api/queue/location`. The driver may still be outside the origin while returning. Location updates preserve enrollment and FIFO time.
6. A passenger at the line's origin checks availability and creates an ordinary configured order. A collecting driver from that same route/direction with enough free seats and no pending offer participates in FIFO. Proximity does not let a later entrant pass an earlier eligible entrant.
7. A single pending offer reserves seats. Accepting it retains those seats without charging twice and preserves previously boarded passengers. Refusal or the default 60-second offer expiry releases only that offer's reservation and advances the ordinary order to the next eligible driver of the same line.
8. Passengers at the origin must be boarded or cancelled before manual `POST /api/queue/depart`. Departure also rejects a pending offer. A full car waits for its driver's explicit action, as does a partly filled car.

The driver's trip phase and each passenger's order status are separate. Boarding one passenger, accepting another or returning to the origin never implicitly presses **Поехали**.

## Passenger API for the additional ordinary order

Use `GET /api/orders/routes` to obtain active configured routes and their current `updatedAt`. The same selection is used for availability and creation:

```json
{
  "route_id": "route-id",
  "direction": "a_to_b",
  "expected_updated_at": "current-route-version",
  "seats": 2
}
```

Send these as query parameters to `GET /api/orders/route/availability`. The response includes `available`, `eligible_driver_count`, `offer_timeout_seconds` and the server fare. Availability is advisory: order creation checks eligibility again under PostgreSQL locks.

For `POST /api/orders/route`, send the selection as JSON and add `pickup_location: { "lat": 42.9, "lng": 71.3 }` using the actual administrator-configured origin coordinates and the passenger's validated pickup. The numbers are illustrative. Optional `pickup_stop_id` and `destination_stop_id` select configured stops in the chosen direction. An origin order defaults to the full direction when both selectors are omitted. The server calculates the fare and creates the offer atomically; no eligible driver returns `409 NO_DRIVERS` without an order or seat debit.

Creation returns `{order, offer}`. The ordinary order is `searching` while the offered driver responds; the offer includes `driver_id`, `queue_position` and `expires_at`. Driver acceptance starts the passenger's pickup deadline. Screens should use the returned order deadline rather than infer an ETA from driver membership in the line. Ordinary configured orders retain the existing seven-minute pickup deadline; external pickup uses its separately quoted road duration plus administrator grace. These deadlines are not live traffic estimates.

The existing order read, cancellation, driver accept/reject, arrival and boarding endpoints continue to own the lifecycle. No new passenger or driver screen is added here.

## Selection and transaction boundaries

- Same route ID, direction, origin pitak and route version are required. A B→A enrollment is not a future A→B enrollment.
- Only `collecting` enrollments in FIFO qualify. A driver who pressed **Поехали** cannot receive new configured offers through this API.
- Previously accepted passengers retain their own reservations. New offers cannot exceed remaining capacity and cannot coexist with another pending offer for that driver.
- Rejection, expiry, cancellation and completion release only the reservation they own. They preserve the collecting driver's enrollment and position.
- Concurrent mutations retain the existing order → queue → users → route lock order. A new order may lock queues before inserting its new UUID; it does not lock another existing order afterward. No routing HTTP calls run under database locks.
- A second PostgreSQL adapter observes the same enrollment, passengers, pending offer and seat balance.

## GPS and acceptance boundary

The acceptance scenario supplies successive valid coordinates getting closer to the origin, while the driver remains outside its geofence. This demonstrates receipt of a new order during that return. It does not add an automatic detector of physical approach or heading.

Ordinary configured-order selection currently uses saved route/direction and collection state. It checks coordinate validity and the mocked flag, but does not compare GPS history or enforce GPS age. A collecting driver may receive an ordinary order while away from the origin for another collection movement as well. External quotation and acceptance have their own administrator-configured GPS freshness checks. This distinction is retained explicitly; detecting direction, defining approach distance/ETA and rejecting stale ordinary telemetry remain separate work.

Reservations for a future opposite-direction leg, and new compatible passengers after **Поехали**, need separate dispatch rules. This stage does not establish either behavior. It also does not establish production OSRM availability, physical GPS accuracy, background location or Android/iPhone acceptance. Mobile integration awaits the user's mockup.
