# Passenger stops within a configured line

The mobile route order screen lets passengers select boarding and destination
stops from the administrator's configured route. For A → C → D → B, both A → C
and C → B are valid. Reverse travel uses B → D → C → A; D → C is valid there.

The initial selection covers the whole line in the chosen direction. Changing
route, direction or catalog version resets the stop draft to those endpoints
before another availability/booking request can use it. The stop picker disables
equal or backwards stops. A changed selection invalidates the old quote and
requires another explicit price/driver check.

The availability GET and booking POST carry the same `pickup_stop_id` and
`destination_stop_id`. The quote key includes both IDs. A selection change while
GPS is pending cannot send a booking for the previous segment. Existing callers
without selectors retain their full-line contract.

The backend remains responsible for configured coordinates, pickup geofence,
route version, fare, direction-specific FIFO and seat allocation. A stop without
valid administrator-configured coordinates is rejected by the existing API;
the client does not invent a price or coordinates. This feature selects stops
on the line; external pickup and villages beyond the endpoint need their own
acceptance.

Ride cards use the booked pickup name from the saved fare rather than confusing
it with the dispatch lane's `pickup_point`. This applies to passenger and driver
cards and passenger history. Existing free-text pickup addresses remain visible.
Idempotent request/recovery behavior from PR #63 remains in use.

Regression coverage includes forward/reverse segments, invalid selectors,
quote invalidation, GET/POST agreement, legacy callers and ride labels. The
existing browser workflow additionally exercises the actual Expo screen against
the local API and PostgreSQL, including a real segment booking and screenshots.
It respects OTP throttling and keeps credentials out of artifacts. Physical GPS
and Android/iPhone device acceptance remain separate.
