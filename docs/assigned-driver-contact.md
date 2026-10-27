# Passenger contact for the assigned driver

`GET /api/orders/:orderId/driver` requires an authenticated passenger session and ownership of that order. Only accepted active stages (`en_route_to_c`, `arrived_at_c`, `boarded_waiting`, `in_transit`) expose contact. Searching/offered, cancelled and completed orders do not. Unknown orders and other passengers return the same 404. Other roles are rejected by the existing role middleware; revoked sessions remain rejected by authentication.

A successful response is `{"driver":{"id":"...","full_name":"...","phone_number":"+..."}}`, with `Cache-Control: no-store`. The controller selects these three fields explicitly, rechecks the current order after reading the account and never changes generic order/socket serialization. Location, session versions, capabilities, route choice and other account fields are excluded. This read endpoint does not change assignment, FIFO, fares or seats.

The existing passenger trip card shows the real assigned name and a telephone action. It fetches from the captured endpoint/session, validates the returned driver ID and a plain E.164 phone before forming a `tel:` action, clears on order/assignment/status/session changes and ignores late aborted responses. Failure offers an explicit retry. No dial action is initiated automatically.

The current user model contains no vehicle profile. This stage therefore does not claim to deliver vehicle make, plate, photo or a verified complete driver card; the UI states that car details are unavailable. Those require a separate persisted driver/vehicle profile and administrator verification. No invented car data is shown.

Regression coverage: real PostgreSQL HTTP ownership/state/role/revocation tests, seven mobile contact/transport/stale-request tests, and additional assertions in the existing ten-step real Expo line cycle. Existing scenario expectations remain. OTP and phone controls are masked in new cycle screenshots; logs record endpoint paths/statuses, not contact payloads. Physical phone calling/GPS and store-release acceptance remain separate.
