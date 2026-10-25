# Administrator order cancellation

`POST /api/admin/orders/:orderId/cancel` requires a current admin JWT and JSON `{ "expected_status": "searching" }` (or the observed current nonterminal status). Other body fields are rejected. Only this dedicated endpoint grants administrative cancellation; ordinary passenger/driver order transitions retain their actor rules.

The store locks order, queue and administrator account in that order. It checks expected order status, current admin role and session version before releasing seats and writing cancelledBy with the real administrator ID in the same transaction. A concurrent accept, cancellation or session revocation either commits first or causes the stale operation to fail. The operation cannot cancel a completed/cancelled order; replay returns409, without another seat credit. Missing orders return404; invalid input400; unauthorized callers401/403.

Cancellation notifications and queue dispatch run after commit. Offered drivers receive offer withdrawal, assigned drivers/passengers receive order status, and queue views refresh. A notification failure does not roll back committed data. Existing transaction and seat-release rules are shared with ordinary lifecycle transitions.

Tests run against both MemoryStore and real PostgreSQL in a private schema, covering role/session guards, pending/assigned/in-transit reservations, terminal orders, actual overlapping PostgreSQL row-lock waiters, session revocation while cancellation waits, and rollback of seat release when the order write fails. No public rows are mutated.

This change adds backend support only. The administrator screen/button, a complete immutable audit journal, cancellation reason workflow, staff subroles and operational acceptance remain separate tasks. No new frontend design is included.
