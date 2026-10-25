# UZS route pricing and rollout

New routes may explicitly use `currency: "UZS"` and `price_per_stop` via the
administrator API. The admin editor defaults new routes to UZS and requires an
entered tariff. Omitting currency through the older API retains KZT behavior.
The currency of an existing route is immutable: create a new route to use another
currency. Updating a tariff does not reprice an accepted or historical order.

## Money contracts

UZS route JSON uses `pricePerStop`; UZS fare JSON uses `total`, `pricePerStop` and
`currency: "UZS"`. UZS responses must not contain KZT-labelled monetary fields.
KZT route JSON retains its legacy shape and KZT fares retain their legacy fields
alongside the identical neutral aliases introduced in the compatibility step.
No exchange rate or numerical currency conversion is applied.

External pickup uses explicit UZS settings (`currency`, `pricePerKm`, `ceil` or
`nearest` rounding), canonical totals and signed v2 quotes. KZT settings, v1
claims, audience and signing key purpose remain compatible. Quote version,
currency, tariff, policy, ownership, session and reserved seats are revalidated;
replaying a committed quote cannot create another booking or change its currency.

## Migration 0012

Apply through the existing migration runner before starting this version.
`currency` and `price_per_stop` are added to route metadata, and the legacy
`price_per_stop_kzt` column becomes nullable for UZS rows. Existing KZT metadata
is backfilled without changing route/order JSON, timestamps or receipt history.
The migration is repeatable; constraints bind to the current schema's route table.
UZS rows require a neutral tariff and a null KZT column. Route payload remains the
runtime authority: a compatible old KZT writer may leave the new projection stale.

Before deployment, take a backup and verify restoration to a separate database.
Drain all pre-UZS application instances before activating any UZS route. Older
binaries remain compatible with KZT-only data, but are **not safe** to serve UZS
route payloads. Once UZS data exists, do not roll back blindly to a pre-UZS image
or delete migration columns. Use an explicitly tested forward repair or restore
the reviewed backup as part of a planned rollback. No destructive down migration
or automatic conversion of existing KZT routes is provided.

## Acceptance boundaries

Automated migration, PostgreSQL/Memory, HTTP and admin browser checks must pass on
the exact review commit. These do not establish real SMS delivery, a running
HTTPS server, cash collection, physical-device GPS or legal/release acceptance.
Production UZS activation and main merge require the owner's release approval.
