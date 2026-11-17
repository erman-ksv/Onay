// Local R06 harness: the actual API/store/socket stack, with test-only binding.
// This entry is never used by production deployment or the Android application.
import { createServer } from "node:http";
import app from "../../artifacts/api-server/src/app";
import { store } from "../../artifacts/api-server/src/store";
import { pool } from "../../lib/db/src/index";
import { createRealtimeServer } from "../../artifacts/api-server/src/socket";
import { processOrderDispatch } from "../../artifacts/api-server/src/services/orderDispatchService";

async function start() {
  if (process.env.ONAY_R06_TEST_ONLY !== "true" || process.env.NODE_ENV !== "test" ||
      process.env.TEZJET_STORAGE_ADAPTER !== "postgres" || process.env.TEZJET_SMS_PROVIDER !== "demo" ||
      process.env.TEZJET_SMS_SEND_ENABLED !== "false" || process.env.REQUIRE_DRIVER_APPROVAL !== "true") {
    throw new Error("TEST_ENVIRONMENT_REQUIRED");
  }
  const database = new URL(process.env.DATABASE_URL ?? "");
  if (!["postgres:", "postgresql:"].includes(database.protocol) ||
      !["127.0.0.1", "localhost", "[::1]"].includes(database.hostname) || database.search || database.hash ||
      !/^\/onay_r06_[a-f0-9]{16,32}$/.test(database.pathname)) throw new Error("ISOLATED_LOCAL_DATABASE_REQUIRED");
  await store.initialize();
  const server = createServer(app);
  const io = createRealtimeServer(server);
  app.locals.io = io;
  await processOrderDispatch(io);
  const timer = setInterval(() => { void processOrderDispatch(io); }, 1000);
  timer.unref();
  let stopping = false;
  async function stop() {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    await new Promise<void>(resolve => io.close(() => resolve()));
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    await pool.end();
    process.exit(0);
  }
  process.once("SIGTERM", () => { void stop(); });
  process.once("SIGINT", () => { void stop(); });
  server.once("error", () => { console.error("ONAY_R06_API_FAILED"); void stop(); });
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") return;
    process.send?.({ ready: true, port: address.port, host: address.address });
  });
}
void start().catch(() => { console.error("ONAY_R06_API_START_FAILED"); process.exit(1); });
