import app from "./app";
import { logger } from "./lib/logger";
import { createServer } from "node:http";
import { createRealtimeServer } from "./socket";
import { store } from "./store";

await store.initialize();

const httpServer = createServer(app);
const io = createRealtimeServer(httpServer);
app.locals.io = io;
const cleanupTimer = setInterval(() => {
  // Seat locks are kept in memory for this runnable API adapter and expire automatically.
  // A database-backed adapter can move this responsibility to a scheduled job.
  void Promise.resolve(store.clearExpiredSeatLocks()).catch((err) => logger.error({ err }, "Seat-lock cleanup failed"));
}, 30_000);
cleanupTimer.unref();

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

httpServer.listen(port, () => {
  logger.info({ port }, "TezJet API and realtime server listening");
});

httpServer.on("error", (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }
});
