import app from "./app";
import { logger } from "./lib/logger";
import { createServer } from "node:http";
import { createRealtimeServer } from "./socket";
import { store } from "./store";
import { processOrderDispatch } from "./services/orderDispatchService";

function failStartup(error: unknown): void {
  logger.error({ err: error }, "API startup failed");
  // Flush the sanitized record before terminating, including when a database
  // pool created during initialization would otherwise keep the process alive.
  logger.flush(() => process.exit(1));
}

async function start(): Promise<void> {
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
  const port = Number(rawPort);
  if (!rawPort || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be configured as an integer between 1 and 65535");
  }

  httpServer.on("error", failStartup);
  httpServer.listen(port, () => {
    logger.info({ port }, "Onay API and realtime server listening");
  });
}

// Never allow initialization rejections to print raw SQL, parameters or causes
// through Node's unhandled-rejection reporting.
void start().catch(failStartup);

