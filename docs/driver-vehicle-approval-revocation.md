# Saved vehicle approval remains required after revocation

With REQUIRE_DRIVER_APPROVAL=false, a driver could submit a car, obtain approval, join the queue and then continue appearing in availability after an administrator rejected that same vehicle. Initial queue admission checked the car, but subsequent dispatch and driver API gates used only the legacy development switch.

Saved vehicles now require current approval at every existing driver approval gate. The shared rule covers authenticated driver middleware, both stores, configured and legacy availability, external pickup candidates, offer creation/revalidation/acceptance and driver mutations. PostgreSQL availability filters the submitted vehicle directly; mutation paths recheck the locked current account using the same rule. Existing lock order and seat ownership/release algorithms are unchanged.

The development switch still applies to legacy accounts without a saved vehicle. Pending or rejected submitted cars cannot use that compatibility exception. No frontend, dependencies, schema, production configuration, main merge or deployment changes.

Regression coverage includes actual HTTP access under the development switch, separately bundled PostgreSQL and MemoryStore adapters with that switch disabled, configured availability/dispatch, legacy-account compatibility, invalidating an existing offer and restoring its seats exactly once. A focused native MemoryStore reproduction failed before the fix and the three focused regression scenarios pass afterwards. Full workspace CI and existing browser checks must pass on the published candidate before acceptance.
