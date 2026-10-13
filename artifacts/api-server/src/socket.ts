import type { Server as HttpServer } from "node:http";
import { Server } from "socket.io";
import { store } from "./store";
import { readSocketToken } from "./middleware/auth";
import { verifyAccessToken } from "./utils/token";
import { logger } from "./lib/logger";
import { PYATAK_ZONE, REQUIRE_DRIVER_APPROVAL } from "./utils/config";
import { emitIncomingOrder } from "./utils/realtime";

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
        REQUIRE_DRIVER_APPROVAL &&
        user.role === "driver" &&
        user.driverApprovalStatus !== "approved"
      ) {
        next(new Error("Driver approval required"));
        return;
      }
      socket.data.userId = user.id;
      socket.data.role = user.role;
      next();
    } catch (err) {
      logger.error({ err, socketId: socket.id }, "Socket authentication failed");
      next(new Error("Authentication unavailable"));
    }
  });

  io.on("connection", async (socket) => {
    const userId = socket.data.userId as string;
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
      socket.emit("queue:snapshot", {
        zone: {
          id: PYATAK_ZONE.id,
          name: PYATAK_ZONE.name,
          center: PYATAK_ZONE.center,
          geofence_meters: PYATAK_ZONE.radiusMeters,
        },
        queue: await store.queueSnapshot(),
        your_position: await store.getQueuePosition(userId),
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
        const driver = await store.getUser(userId);
        if (
          REQUIRE_DRIVER_APPROVAL &&
          driver?.driverApprovalStatus !== "approved"
        ) {
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
