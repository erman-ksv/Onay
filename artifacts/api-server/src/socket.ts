import { hasRequiredDriverApproval } from "./utils/driverVehicle";
import type { Server as HttpServer } from "node:http";
import { Server } from "socket.io";
import { store } from "./store";
import { readSocketToken } from "./middleware/auth";
import { verifyAccessToken } from "./utils/token";
import { logger } from "./lib/logger";
import { PYATAK_ZONE, REQUIRE_DRIVER_APPROVAL } from "./utils/config";
import { emitIncomingOrder } from "./utils/realtime";
import { queueStatusView } from "./services/queueView";

export function createRealtimeServer(httpServer: HttpServer): Server {
  const io = new Server(httpServer, {
    path: "/api/socket.io",
    cors: {
      origin: process.env.CORS_ORIGIN?.split(",").map((origin) => origin.trim()) ?? "*",
      credentials: true,
    },
    transports: ["websocket", "polling"],
  });

  io.use(async (socket, next) => {
    try {
      const token = readSocketToken(socket.handshake.auth?.token);
      const claims = token ? verifyAccessToken(token) : null;
      const user = claims?.sub ? await store.getUser(claims.sub) : undefined;
      if (
        !claims ||
        !user ||
        user.sessionVersion !== claims.sessionVersion ||
        user.role !== claims.role
      ) {
        next(new Error("Unauthorized"));
        return;
      }
      if (
        user.role === "driver" &&
        !hasRequiredDriverApproval(user, REQUIRE_DRIVER_APPROVAL)
      ) {
        next(new Error("Driver approval required"));
        return;
      }
      const expiresAt = (claims as typeof claims & { exp?: number }).exp;
      if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) {
        next(new Error("Unauthorized"));
        return;
      }
      socket.data.expiresAt = expiresAt * 1000;
      socket.data.userId = user.id;
      socket.data.role = user.role;
      socket.data.sessionVersion = user.sessionVersion;
      socket.data.accessToken = token;
      next();
    } catch (err) {
      logger.error({ err, socketId: socket.id }, "Socket authentication failed");
      next(new Error("Authentication unavailable"));
    }
  });

  io.on("connection", async (socket) => {
    const userId = socket.data.userId as string;
    const token = socket.data.accessToken as string;
    // A live transport must not extend the lifetime of its access token.
    const expiresAt = socket.data.expiresAt as number;
    let expiryTimer: ReturnType<typeof setTimeout> | undefined;
    const scheduleExpiry = (): void => {
      const remaining = expiresAt - Date.now();
      if (!Number.isFinite(remaining) || remaining <= 0) {
        socket.disconnect(true);
        return;
      }
      expiryTimer = setTimeout(scheduleExpiry, Math.min(remaining, 2_147_483_647));
      expiryTimer.unref();
    };
    socket.once("disconnect", () => clearTimeout(expiryTimer));
    scheduleExpiry();
    if (!socket.connected) return;
    socket.join(`user:${userId}`);
    socket.join(`queue:${PYATAK_ZONE.id}`);
    socket.emit("connected", {
      user_id: userId,
      events: [
        "incoming_order",
        "order:status",
        "order:offer_withdrawn",
        "queue:snapshot",
        "queue:update",
        "queue:joined",
        "queue:left",
        "queue:status",
        "queue:location",
        "queue:position",
        "queue:reordered",
        "queue:order_offer",
        "push_alert",
      ],
    });
    try {
      const user = await store.getUser(userId);
      if (!user || user.sessionVersion !== socket.data.sessionVersion || user.role !== socket.data.role ||
          (user.role === "driver" && !hasRequiredDriverApproval(user, REQUIRE_DRIVER_APPROVAL))) {
        socket.disconnect(true);
        return;
      }
      socket.emit("queue:snapshot", {
        ...await queueStatusView(user),
        updated_at: new Date().toISOString(),
      });
      if (socket.data.role === "driver") {
        const orders = await store.listOrdersForUser(userId);
        for (const order of orders) {
          if (order.status === "searching" && order.offeredDriverId === userId &&
              (order.offerExpiresAt ?? 0) > Date.now() && socket.connected) {
            emitIncomingOrder(io, userId, order);
          }
        }
      }
    } catch (err) {
      logger.error({ err, userId, socketId: socket.id }, "Socket queue initialization failed");
      socket.disconnect(true);
      return;
    }
    logger.info({ userId, socketId: socket.id }, "Socket client connected");

    socket.on("driver:location", async (location: unknown) => {
      if (socket.data.role !== "driver") {
        return;
      }
      try {
        if (!verifyAccessToken(token)) {
          socket.disconnect(true);
          return;
        }
        const driver = await store.getUser(userId);
        if (!socket.connected || !verifyAccessToken(token) || !driver || driver.role !== "driver" || driver.sessionVersion !== socket.data.sessionVersion) {
          socket.disconnect(true);
          return;
        }
        if (
          !hasRequiredDriverApproval(driver, REQUIRE_DRIVER_APPROVAL)
        ) {
          socket.disconnect(true);
          return;
        }
        socket.broadcast.emit("driver:location", {
          driver_id: userId,
          location,
        });
      } catch (err) {
        logger.error({ err, userId, socketId: socket.id }, "Socket driver location failed");
      }
    });

    socket.on("disconnect", (reason) => {
      logger.info({ userId, socketId: socket.id, reason }, "Socket client disconnected");
    });
  });

  return io;
}
