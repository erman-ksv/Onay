# Fare money contract — compatibility step

This document describes the earlier KZT compatibility step. For current UZS
contracts, migration and activation restrictions, see [UZS rollout](ONAY_UZS_ROLLOUT.md).

This additive step prepares the server for currency-neutral clients. The runtime
still creates KZT fares; it does not enable UZS tariffs or convert any stored value.

## Fare responses

| Field | Meaning | Compatibility |
| --- | --- | --- |
| `currency` | Explicit currency, currently `KZT` | Unchanged |
| `total` | The frozen total in that currency | Added; equals `totalKzt` for KZT |
| `pricePerStop` | The frozen per-stop tariff | Added; equals `pricePerStopKzt` for KZT |
| `totalKzt`, `pricePerStopKzt` | Existing KZT fields | Retained with unchanged values |

Legacy estimates and configured-route availability/booking use the same aliases.
External-pickup confirmation sets both totals to base fare plus the agreed pickup
surcharge. The external quote response adds `total` alongside `total_kzt`; signed
quote claims and their validation remain unchanged.

## Stored orders and rollout

New orders persist the aliases with their agreed fare. Historical orders may lack
the aliases: serialization returns an enriched copy of their stored fare. It does
not read the current route tariff, rewrite historical JSON, alter timestamps,
refresh a receipt or reserve/release seats. Older KZT clients retain their fields.

Malformed, unsafe, negative, unsupported-currency or contradictory KZT fare values
are rejected instead of selecting an arbitrary amount. Zero remains valid for
compatibility with the existing tariff API.

No schema or historical migration changes are included. This step can be rolled
back independently while fares remain KZT: older code ignores the added keys.
This does not establish rollback safety after a future UZS data migration.

## Remaining UZS work

Use a new additive migration and explicit administrator-entered UZS tariffs.
Preserve historical KZT amounts and currencies. Update route pricing, external
pickup settings/signed quote versions and the administrator UI together with
regressions. A successful compatibility test is not acceptance of a real UZS ride,
SMS delivery, a deployed server or physical-device operation.
