# Onay

Onay is a rural taxi hailing API with OTP authentication, FIFO driver queueing, route pooling, and realtime trip updates.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/api-server/src/routes` — auth, queue, order, and notification endpoints
- `artifacts/api-server/src/controllers` — request orchestration and business rules
- `artifacts/api-server/src/middleware` — JWT session checks, role checks, and anti-fake GPS
- `artifacts/api-server/src/store/memoryStore.ts` — runnable in-memory state adapter
- `artifacts/api-server/src/socket.ts` — authenticated Socket.io events
- `artifacts/api-server/README.md` — API usage and event reference

## Architecture decisions

- JWT session versions invalidate every previous token when a user logs in again.
- The queue keeps drivers with an active pickup or pooled trip ahead of waiting drivers.
- Point C seats are reserved for seven minutes and then automatically released.
- Point D pooling targets the first in-transit driver with sufficient remaining seats.

## Product

Passengers register with OTP, request rural trips, and receive live status updates. Drivers join a geofenced FIFO queue, accept pickups, maintain their queue priority, and receive high-priority pooled trip offers.

## User preferences

The product name is Onay.

## Gotchas

The current adapter stores users, queues, orders, OTPs, and device registrations in memory. Use a durable database and shared cache before running multiple production instances.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
