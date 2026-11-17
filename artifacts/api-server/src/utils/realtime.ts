import type { Server } from "socket.io";
import type { Order } from "../types/domain";
import { store } from "../store";
import { serializeOrder } from "./serialize";
import { PYATAK_ZONE } from "./config";
import { queueSocketStatusView } from "../services/queueView";
import { AppError } from "./errors";
import { logger } from "../lib/logger";

export type QueueEventType =
  | "joined"
  | "left"
  | "status"
  | "location"
  | "reordered"
  | "order_assigned"
  | "order_released"
  | "order_offer"
  | "passenger_boarded"
  | "departed"
  | "seat_lock_expired";

interface QueueChange {
  type: QueueEventType;
  driverId?: string;
}

export async function emitQueueUpdate(io: Server | undefined, change: QueueChange = { type: "reordered" }): Promise<void> {
  if (!io) {
    return;
  }
  const allQueue = await store.queueSnapshot();
  const recipients = await io.fetchSockets();
  const updatedAt = new Date().toISOString();
  for (const recipient of recipients) {
    try {
      const view = await queueSocketStatusView(recipient.data, allQueue);
      const visibleChange = change.driverId &&
        (change.driverId === recipient.data.userId || view.queue.some(entry => entry.driverId === change.driverId));
      const payload = {
        ...view,
        event: change.type,
        ...(visibleChange ? { changed_driver_id: change.driverId } : {}),
        updated_at: updatedAt,
      };
      recipient.emit("queue:update", payload);
      recipient.emit(`queue:${change.type}`, payload);
      if (change.type !== "reordered" && change.type !== "location") {
        recipient.emit("queue:reordered", payload);
      }
      if (recipient.data.role === "driver") {
        recipient.emit("queue:position", {
          zone_id: view.zone?.id ?? PYATAK_ZONE.id,
          route_context: view.your_entry?.routeContext ?? null,
          position: view.your_position,
          status: view.your_entry?.status ?? "not_in_queue",
          updated_at: updatedAt,
        });
      }
    } catch (err) {
      if (err instanceof AppError && (err.statusCode === 401 || err.statusCode === 403)) {
        recipient.disconnect(true);
      } else if (!(err instanceof AppError && err.statusCode === 409 && err.code === "ROUTE_CHANGED")) {
        logger.error({ err, socketId: recipient.id }, "Socket queue notification failed");
      }
    }
  }
}

export function emitOrderUpdate(io: Server | undefined, order: Order): void {
  if (!io) {
    return;
  }
  const payload = {
    order: serializeOrder(order),
    updated_at: new Date().toISOString(),
  };
  io.to(`user:${order.passengerId}`).emit("order:status", payload);
  if (order.driverId) {
    emitDriverOrderUpdate(io, order.driverId, order);
  }
}

export function emitDriverOrderUpdate(
  io: Server | undefined,
  driverId: string,
  order: Order,
): void {
  io?.to(`user:${driverId}`).emit("order:status", {
    order: serializeOrder(order, true),
    updated_at: new Date().toISOString(),
  });
}

export function emitOrderOfferWithdrawn(
  io: Server | undefined,
  driverId: string,
  order: Order,
): void {
  io?.to(`user:${driverId}`).emit("order:offer_withdrawn", {
    order_id: order.id,
    order: {
      ...serializeOrder(order, true),
      driver_id: undefined,
      offered_driver_id: undefined,
      offer_expires_at: undefined,
    },
    updated_at: new Date().toISOString(),
  });
}

export function emitIncomingOrder(
  io: Server | undefined,
  driverId: string,
  order: Order,
): void {
  io?.to(`user:${driverId}`).emit("incoming_order", {
    priority: "high",
    sound: "incoming_order.mp3",
    order: serializeOrder(order, true),
    received_at: new Date().toISOString(),
  });
}
