# Administrator cancellation audit

Migration0009 adds `tezjet_admin_audit_events`. Every successful dedicated administrator cancellation inserts one event in the same transaction as the order and queue updates. Event fields:ID,administrator account ID,action `order.cancelled`,order ID,previous/new status and UTC time. No names,phones,coordinates,tokens or order snapshots are stored. A unique(action,order_id) index complements the order lifecycle's single successful cancellation. Failed/replayed/stale/unauthorized operations do not add events; an audit write failure rolls back the order and seat release.

`GET /api/admin/audit-events` requires a current admin JWT. Optional `order_id` filters a single order; `limit` is1–100(default50). Results sort by createdAt then ID descending and use `Cache-Control: no-store`. This is a bounded recent-events endpoint, not an export/pagination or dispute-resolution interface. There are no HTTP insert/edit/delete endpoints.

Ordinary database UPDATE,DELETE and TRUNCATE are rejected by migration triggers, including empty-match mutations. IDs are retained without foreign-key cascades so deleting an operational user/order cannot silently remove history. This is not cryptographic tamper proofing: the database owner/superuser can disable triggers,change functions or drop objects. Separate runtime DB privileges,external protected logging,retention/legal policy and backup monitoring remain deployment work. Do not use the application audit table for secrets or unrestricted personal snapshots.

The regression suite executes the actual migration SQL in its private PostgreSQL schema so trigger enforcement is tested, rather than relying on LIKE-table cloning which does not copy triggers. It verifies audit insertion atomicity,one record after concurrent cancellation,role/privacy/input bounds,immutable returned copies in MemoryStore,persistence across PostgreSQL store instances,and blocked UPDATE/DELETE/TRUNCATE. Existing transaction lock order(order→queue→actor) remains unchanged.

Scope covers administrator order cancellation, driver approval changes and route metadata updates. Other route mutations,failed-attempt audit,staff roles,administrator journal UI,dispute workflow and operational retention/export remain open. Existing historic cancellations are not backfilled because their actor/time cannot be reliably reconstructed.


## Driver approval changes

Migration0010 extends the same table with nullable driver_id/vehicle_revision and permits order_id to be absent for driver events. Existing cancellation JSON remains unchanged: unused nullable columns are omitted. GET audit-events additionally accepts driver_id; filters intersect when combined.

The existing PATCH admin/drivers/:id/approval now uses an audited store operation. It locks driver and administrator account rows in canonical ID order,checks the live administrator role/session and the submitted vehicle revision,then writes status and `driver.approval_changed` atomically. A repeated identical status returns success without a new event; actual transitions retain previous/new status and the reviewed vehicle revision when present. Audit insertion failure rolls the approval back. No phone,name,plate,car snapshot,GPS or tokens are copied to the journal.

Tests verify authorized HTTP transitions/filtering,no-op deduplication,live role/session guards,stale vehicle revision refusal,reviewed revision persistence,audit-write rollback and actual PostgreSQL lock overlap for duplicate reviews. Legacy trusted store fixture setters are retained;HTTP clients use only the audited administrator operation. Test schemas include the migrated audit table;the dedicated audit suite executes both actual migration scripts to exercise protected history.

This does not add staff roles,driver ban/unban semantics,an administrator journal screen or dispute handling. It does not backfill approvals made before this migration. Database owner/superuser DDL bypass remains outside the trigger guarantee.


## Route metadata and tariffs

Migration0011 adds route_id,changed_fields and previous/next route versions,plus a route/time index. Status fields are nullable because a route update is not an order/driver status transition. Existing cancellation and approval JSON omits unused nullable columns as before. GET audit-events accepts route_id; filters intersect.

The existing PATCH /admin/routes/:routeId passes a server-derived administrator ID/session to the store. Its transaction locks the route,then the administrator account,checks current role/session and writes both route and route.updated event. A failed event write rolls the route/tariff/version back. Identical metadata is a no-op with no new version/event. Only actual differences in the fixed fields name,active,pricePerStopKzt are recorded. Events retain field names and route versions,not names,price values,geometry or arbitrary request snapshots. They identify who changed which fields;they are not a historical price reconstruction or full dispute export.

Tests cover HTTP authorization/filtering/compatibility,no-op behavior,Memory/PostgreSQL current session checks,copy isolation,transaction rollback,actual concurrent identical writes and session revocation while waiting on an account lock. Trusted internal fixture writers remain available;HTTP metadata edits always pass the administrator context.

Creation/deletion,stop/layout edits,external-pickup settings and the legacy in-process queue-point endpoint are not audited by this change. Their journal coverage,staff roles,dispute handling and the administrator history UI remain open. No production migration or historic backfill was performed.
