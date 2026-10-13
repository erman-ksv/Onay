import app from "./app";
import { logger } from "./lib/logger";
import { createServer } from "node:http";
import { createRealtimeServer } from "./socket";
import { store } from "./store";
import { processOrderDispatch } from "./services/orderDispatchService";

await store.initialize();

const httpServer = createServer(app);
const io = createRealtimeServer(httpServer);
app.locals.io = io;
await processOrderDispatch(io);
const cleanupTimer = setInterval(() => {
  void processOrderDispatch(io).catch((err) => logger.error({ err }, "Order dispatch cleanup failed"));
}, 1_000);
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

