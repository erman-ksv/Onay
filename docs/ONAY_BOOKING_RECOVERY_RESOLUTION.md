# Resolving an uncertain route booking

A missing receipt or empty order list does not prove that an older POST cannot
still commit. The app never unlocks another booking from 404 alone.

`POST /api/orders/route/requests/:requestKey/resolve` accepts only an empty body,
requires the current passenger session and returns a non-cacheable result:

- `state: created`, the matching request key and its saved order: restore that
  ride without cancelling, repricing or reserving seats again.
- `state: closed` and the matching key: no order was committed for this intent,
  and every later attempt using the key is durably refused.

The stores serialize resolution and booking by the existing full passenger/key
advisory-lock identity. Closure is idempotent and scoped to the authenticated
passenger. Missing referenced orders, revoked sessions and unknown failures stay
fail-closed. Only new closures are limited to 64 per passenger in a rolling 24 hours;
existing closures and created-order retrieval do not consume that quota.

## Migration 0013 and older writers

Apply 0013 with the existing migration runner before starting this API. It adds a
separate closed-key table, without modifying existing receipts/orders. Closed
identities have no TTL: pruning them would allow a delayed request to create an
order again. Store only the passenger ID, request key and closure time, never
phone numbers, tokens, GPS or booking payloads.

Receipt and closed-key INSERT triggers acquire the exact existing advisory key
and reject coexistence. This also fences a receipt-capable older server: if it
allocated seats before inserting a closed receipt, its entire transaction rolls
back. Trigger lookups bind to their actual table schema. Do not remove these
triggers or closed identities when rolling back application code. Pre-receipt
servers that ignore idempotency keys are outside this protocol and must not serve
traffic with a current client.

## Client behavior

First try the existing receipt lookup. Only the specific missing/closed receipt
response leads to resolution; generic 404, malformed replies or network failures
are not proof. A matching closure must be followed by an accepted fresh orders
snapshot and successful removal of that exact uncertain local record. A newer
intent, confirmed receipt, changed session, stale snapshot or storage failure
does not unlock the forms. A new booking requires a fresh quote and an explicit
user action with a new key; no automatic booking retry is introduced.

Legacy unknown bookings without a request key remain fail-closed for support.
The protocol protects retries of one intent; it does not add a cross-device
one-active-order business rule. Real SMS, public HTTPS and physical-device/network
acceptance remain separate release requirements.
