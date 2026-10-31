# Administrator offer timeout (registry 9.6)

The administrator can change the driver's time to answer a new offer from **Settings** in `/admin`. Only whole seconds from 1 to 3600 are accepted. The default remains `TEZJET_OFFER_TIMEOUT_SECONDS` (60 unless configured) until the first explicit administrator save. After that, the persisted PostgreSQL value takes precedence across API processes and restarts.

Authenticated administrator endpoints:

- `GET /api/admin/settings/offer-timeout` returns `{offer_timeout:{seconds,revision,updatedAt}}`. An unconfigured value has null revision and timestamp.
- `PUT /api/admin/settings/offer-timeout` accepts exactly `{seconds,expected_revision}`. Send the revision from the last confirmed read, including explicit null on first save. A stale revision returns 409 `OFFER_TIMEOUT_CHANGED`; read the setting again before deciding whether to save.

Both reads and writes use private no-store responses. The write rechecks the administrator's current role and session after acquiring the policy lock. The policy update and `settings.offer_timeout_changed` audit event commit together. Saving an already persisted identical value with its current receipt makes no new event. The first explicit save, even of the environment default, creates a durable receipt.

The effective setting applies when a new offer is issued: ordinary initial offers, FIFO rejection/expiry redistribution, and external-pickup confirmations/reconfirmations. Existing pending deadlines and idempotent order/quote replay retain their original deadline. Accepted trips, boarding/seat-lock deadlines, fares and routing policies do not change. Passenger availability reports the current effective value; order creation still validates live eligibility independently.

After conflict or an unknown write result, the admin form preserves the draft but clears its confirmed policy and disables saving until an explicit refresh. It never automatically retries a write. Leaving Settings unmounts the form and discards late responses. Refresh replaces unsaved input with confirmed server data.

Migration `0016_offer_timeout_policy` adds one settings row and nullable audit columns without rewriting old orders, deadlines or audit history. Apply migrations before starting the new API. Reads use PostgreSQL MVCC without acquiring a settings row lock inside booking/driver transactions; settings writes lock the setting before rechecking the actor. This does not add Socket.IO synchronization across API processes.

Acceptance covers both store implementations, real HTTP/PostgreSQL permissions and concurrency, audit rollback, upgrade from0015 using the actual migrator, external-pickup receipt replay, client contracts, and real browser saves/conflicts/unknown outcomes/unmount/desktop/mobile/audit. No live SMS, physical-device acceptance or APK build is part of this change. Registry9.6 is evaluated once; related5.5 is not automatically credited a second time.
