# Bounded API and queue load

Run after applying migrations to a dedicated test PostgreSQL database:

```sh
pnpm --filter @workspace/api-server run test:load
```

DATABASE_URL is mandatory. The suite creates its own random schema with production columns/indexes, starts the real HTTP app on an ephemeral loopback port and uses the PostgreSQL runtime adapter. It drops only that schema on teardown. It has no configurable remote target, uses no production users and sends no SMS. Fixture accounts and tokens are seeded through production store/token functions, so this does not measure OTP delivery or login throughput.

Workload:20 drivers,80 passengers, concurrency at most20. The six measured phases are driver route/queue enrollment(40 requests), availability(120), booking saturation(80), idempotent retries(40), driver acceptance(20) and duplicate cancellations(40):340 HTTP requests total. Enrollment establishes deterministic FIFO before the bursts. Saturation must create exactly20 distinct offers and refuse60 excess requests with409/NO_DRIVERS, without creating orphan orders. Every successful booking gets one driver. Replays preserve the order ID and reserved seats; exactly one of each duplicate cancellation pair commits, and all drivers regain their original capacity.

CI runs this after ordinary API tests, avoiding interference from the other test suites. Output `artifacts/queue-load/report.json` contains phase p50/p95/p99/max latency, observed throughput and status counts; no tokens, phone numbers, coordinates, user IDs or request/response bodies. CI uploads only that JSON. A nonzero test exit fails the CI gate.

The load is finite, with15-second HTTP deadlines and a120-second test timeout. Correctness and unexpected failures are gating; latency figures are observations, not an arbitrary pass threshold. This is one HTTP instance, loopback and a shared CI runner, not a production capacity, endurance, network/mobile, Socket.IO scale or multiple-server test. Re-run against the chosen deployment using a separately approved operational test plan before setting production targets.
