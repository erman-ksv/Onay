# Directional queue isolation: scoped 6.5 acceptance

A driver enrolled in the B→A queue must not receive an A→B order. The rule works symmetrically, even when that driver joined earlier, has more free seats or is physically closer to the passenger. This is isolation of the driver's saved line enrollment; determining physical movement from GPS remains separate work.

## What identifies a queue

The server derives the immutable queue context from the driver's saved route selection and the live administrator route. It includes route ID, direction, origin pitak and route version. A→B belongs to A; B→A belongs to B. Changing a request's pickup label, supplying a driver ID or reporting another location does not change that context.

Initial enrollment requires the correct origin geofence. A collecting driver may subsequently travel for external pickups without losing the enrollment, as documented in [returning line driver](returning-line-driver.md). Being near a different origin does not enroll that driver in its queue. To change lines or direction, finish pending/active work, leave the queue, update the saved selection, reach the new origin's validated geofence and explicitly enroll again. The collecting mode assigns a new enrollment identifier; either queue mode starts a new FIFO time.

## Ordinary route orders

`GET /api/orders/route/availability` and `POST /api/orders/route` select only the requested current route/direction's eligible enrollment. Availability is advisory; creation repeats the decision under PostgreSQL row locks. If only the opposite queue is available, availability reports zero eligible drivers and creation returns `409 NO_DRIVERS`, with no new order and no seat reservation.

The same restriction applies after refusal and the default 60-second offer expiry. Once all eligible drivers of the requested line are exhausted, the order remains `searching` without a pending offer. It does not fall back to the opposite queue. A newly eligible driver in the correct line may subsequently receive it. Ordinary offers retain their line's FIFO.

Only the exact offered driver may accept. Accepting a guessed order ID, rejecting it or changing the driver's route selection cannot transfer the reservation to another line. Order access and lifecycle actions use the authenticated actor; editable body fields do not replace that identity.

## External pickup quotes

External pickup first filters collecting enrollments by route, direction, version, capacity, pending offer, approval and server-received GPS freshness. Road-distance ranking then chooses among those eligible drivers. A nearby opposite-direction driver is excluded before road routing, so distance cannot cross queue boundaries. See [external pickup](external-pickup.md) for administrator policy and price consent.

After refusal, expiry or invalidation, the passenger must approve a new quote. If only the opposite queue remains, quotation returns `409 NO_DRIVERS` without a new reservation or price change. A driver who has legitimately left and re-enrolled in the requested direction becomes a different enrollment and can be considered by a fresh quote.

Quoting alone reserves no seats. If the quoted driver leaves, changes direction and re-enrolls before confirmation, the old token cannot reserve that driver's new enrollment. Confirmation rechecks the driver's current queue and rolls back the new order envelope when the quote is no longer current. No stale quote can debit seats in the new opposite-direction queue.

## Acceptance boundary

The integration tests use the actual Express application, private PostgreSQL schemas with real migrated indexes/locks, and a controlled HTTP road-routing fixture. They check the ordinary and external paths, direct attempts by the wrong driver, exhausted offers, direction changes between quote and confirmation, and unchanged orders/seat owners after rejection.

The application already implements directional isolation. This acceptance stage supplies targeted regression evidence and documentation. It does not add a physical GPS-heading detector or a prohibition based only on the driver's current coordinates. The existing collection behavior remains valid: an A→B collecting enrollment can be away from A while collecting passengers.

Future opposite-direction reservations and new pickups after **Поехали** need their own dispatch rules. Physical GPS, background location, production routing coverage and Android/iPhone acceptance remain separate. Frontend integration awaits the user's mockup.
