# Driver blocking (task 9.3)

Blocking is distinct from vehicle review. A blocked driver cannot use approved-driver operations or obtain new offers. The explicit block also applies to legacy accounts without a car when REQUIRE_DRIVER_APPROVAL=false. Normal user login and passenger mode remain available.

PATCH /api/admin/drivers/:driverId/block is administrator-only. Send { "blocked": true, "expected_vehicle_revision": "<displayed revision or null>" }. Use blocked:false to remove the block. The displayed car revision is required even for an account without a car (null). Stale revisions return409 VEHICLE_REVIEW_CHANGED. Both commands recheck the live administrator session under the existing transaction locks and record actual changes in driver.approval_changed audit events. Repeated commands do not duplicate state changes or audit events.

Unblocking sets blocked→pending. Vehicle approval is a separate explicit administrator action. Repeating unblock after a later approval does not reset that approval. Ordinary approval/rejection/pending commands cannot clear an explicit block (409 DRIVER_BLOCKED). Saving a car or switching passenger/driver mode does not clear the block.

The administrator UI requires confirmation, captures the displayed car receipt, and requires a fresh read after a conflict or unconfirmed response. Credentials stay in memory. No automatic mutation retry occurs.

After blocking, the existing dispatcher releases a pending offer and chooses another eligible driver with the unchanged FIFO/seat rules. An assigned trip is not silently cancelled or released. Approved-driver trip operations are unavailable while blocked; an administrator must explicitly resolve an existing trip (for example, use the existing admin cancellation command if cancellation is appropriate). The confirmation states that active orders are not automatically cancelled.

The mobile profile distinguishes blocked from pending/rejected and retains the blocked result after a car edit. This does not add a push service, multi-API Socket.IO synchronization, or physical-device acceptance.
