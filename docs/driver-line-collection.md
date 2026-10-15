# Driver line collection API

This change adds the backend for collecting passengers before a manual departure. It does not add mobile screens. Existing clients keep their `/api/queue/join` lifecycle; the future **В линию** button uses the explicit new endpoint below. Switching between queue modes requires leaving an idle queue first.

## Enroll in a line

`POST /api/queue/line` accepts the same fields as the existing configured join:

```json
{
  "route_choice": {
    "route_id": "configured-route-id",
    "direction": "a_to_b",
    "expected_updated_at": "current-route-version"
  },
  "available_seats": 4,
  "location": { "lat": 42.9, "lng": 71.3, "timestamp": 1792044000000 }
}
```

The driver must have the same saved route choice, current driver mode and approval. Initial enrollment verifies the administrator's origin geofence. Capacity is 1–8 seats and remains fixed for this enrollment. The server returns `entry.collectionState` containing a unique `enrollmentId`, `phase: collecting`, capacity and the server time of the latest location receipt. Repeating an idle join preserves the identifier, capacity and FIFO priority. Joining while assigned orders or an offer exist is rejected.

During collection the queue stays in FIFO even when full or away from the origin. Offers use the configured direction's FIFO and seat availability. One driver can have several accepted orders but only one pending offer. Offer reservation debits seats; acceptance and boarding do not debit them again. Cancellation, rejection and expiration release only the reservation they own.

## Confirm boarding

After the assigned driver's existing status transition to `arrived_at_c`, call `POST /api/orders/:orderId/board` with an empty body. The server verifies the live assigned actor, session, approval, collection phase and pickup deadline, then sets `boarded_waiting`. The response is `{ "order": ... }`.

Boarding clears only this order's pickup deadline and retains its seats. A boarded passenger can wait for the car to fill. This action records the driver's confirmation; it does not claim physical GPS or device acceptance. Repeated boarding cannot debit seats again. The ordinary order status endpoint cannot start an individual order while its car is collecting: it returns `DEPART_REQUIRED`.

## Depart manually

`POST /api/queue/depart` accepts only:

```json
{ "expected_enrollment_id": "the-current-enrollment-uuid" }
```

The transaction changes the enrollment to `departed`, removes FIFO membership and changes all `boarded_waiting` orders to `in_transit`. It does not alter available seats. Empty, partly filled and full cars can depart. The response contains `entry`, the enrollment's `orders`, `changed` and `position: null`. Repeating the command for the same enrollment returns `changed: false`; an old identifier cannot depart a later enrollment.

Resolve a pending offer before departure (`QUEUE_BUSY`). Accepted passengers at the origin must be boarded or cancelled first (`PASSENGERS_NOT_BOARDED`). Accepted future pickups at configured intermediate stops can remain unboarded at departure; they are not marked as already on board. Their existing pickup deadlines still apply. Editing or deleting the route catalog does not strand already boarded passengers: departure uses the accepted snapshots.

After departure, cancellation and completion return only their own seats and do not restore FIFO. New configured offers are excluded until a fresh enrollment. Taking new compatible passengers in transit requires the separate Smart Pickup implementation.

PostgreSQL departure reads an order manifest, locks existing orders in stable ID order, then locks and rechecks the queue and current actor. A changed manifest rolls back before retrying. No departure path locks the queue and subsequently waits for an existing order. Migration `0006_line_collection.sql` adds a nullable JSONB column; preexisting rows retain their previous lifecycle.

## External pickup and returning to the line

The external-pickup backend was added separately in PR #43. See [external pickup](external-pickup.md) for the explicit administrator policy, road-routing configuration, nearest eligible driver, price confirmation and repricing after refusal or timeout. A different driver requires a new passenger-approved quote; external offers do not automatically pass to another driver at an unconfirmed fare.

A collecting driver returning after an external pickup can also receive an ordinary order from the same configured line while still outside the origin geofence. These ordinary orders retain FIFO, the enrollment and the one-pending-offer limit. See [returning line driver](returning-line-driver.md) for the scoped 6.4 acceptance and its GPS boundary.

Ordinary rides outside a line remain a separate negotiated-price mode: the passenger proposes a price; drivers can accept, decline or counteroffer; the passenger chooses an offer before assignment.

Frontend work awaits the user's mockup. Physical GPS, Android/iPhone testing, production routing deployment and new compatible pickups after departure remain separate acceptance work. Backend acceptance does not establish that the current mobile screens complete those scenarios.
