# Driver line: closing a completed run and starting another

A queue enrollment and its FIFO position are separate. A departed line or a completed configured trip may retain `your_entry` with `your_position: null`. The server intentionally keeps that origin enrollment until `DELETE /api/queue/leave`; changing direction while it exists is rejected.

The mobile screen now reads membership from the complete `/api/queue` response. A null position/socket event cannot authorize a new join. Unknown, malformed or previous-session state keeps queue joins, capacity changes and route edits locked until an authoritative response arrives. Local write acknowledgements invalidate older GETs separately from position updates. Successful DELETE is required before the UI clears membership.

After all trips finish, the driver can close the old line, choose the reverse direction, and enroll again at its pitak. Pending offers and active trips continue to disable leaving; the backend independently enforces its existing 409 guard. A synchronous guard prevents overlapping queue join/depart/location/leave requests within the screen, including double taps before React rerenders. It does not promise idempotency across devices or uncertain network failures; refresh establishes the authoritative state.

Departure uses an inline confirmation on native and Expo Web. Its receipt is bound to the current session and server enrollment ID. Cancel sends no departure request; confirm sends the unchanged `expected_enrollment_id` contract. There are no server, fare, authorization or seat-accounting changes.

## Verification

- Six focused membership/session/mutation tests plus existing mobile regressions.
- Actual exported Expo Web, API and PostgreSQL in the existing browser QA job: two separate passenger/driver browser contexts, booking, reservation, acceptance, boarding/waiting, confirmation/cancel, departure, completion, close, reverse direction and fresh enrollment. Existing driver and passenger-stop scenarios remain intact.
- Browser GPS is emulated at nearby fixture points using real observation times. This does not establish physical phone GPS, background behavior, production SMS or store-release readiness.
- Screenshots and redacted browser reports are uploaded with the existing QA artifact. Codespaces and AI/model providers are not used.
