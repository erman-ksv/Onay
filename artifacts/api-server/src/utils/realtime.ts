import type { Server } from "socket.io";
import type { Order } from "../types/domain";
import { store } from "../store";
import { serializeOrder } from "./serialize";
import { PYATAK_ZONE } from "./config";

export type QueueEventType =
  | "joined"
  | "left"
  | "status"
  | "location"
  | "reordered"
  | "order_assigned"
  | "order_released"
  | "seat_lock_expired";

interface QueueChange {
  type: QueueEventType;
  driverId?: string;
}

export async function emitQueueUpdate(io: Server | undefined, change: QueueChange = { type: "reordered" }): Promise<void> {
  if (!io) {
    return;
  }
  const queue = await store.queueSnapshot();
  const payload = {
    zone: {
      id: PYATAK_ZONE.id,
      name: PYATAK_ZONE.name,
      center: PYATAK_ZONE.center,
      geofence_meters: PYATAK_ZONE.radiusMeters,
    },
    event: change.type,
    changed_driver_id: change.driverId,
    queue,
    updated_at: new Date().toISOString(),
  };
  io.to(`queue:${PYATAK_ZONE.id}`).emit("queue:update", payload);
  io.to(`queue:${PYATAK_ZONE.id}`).emit(`queue:${change.type}`, payload);
  if (
    change.type !== "reordered" &&
    change.type !== "location"
  ) {
    io.to(`queue:${PYATAK_ZONE.id}`).emit("queue:reordered", payload);
  }
  for (const entry of queue) {
    io.to(`user:${entry.driverId}`).emit("queue:position", {
      zone_id: PYATAK_ZONE.id,
      position: entry.position,
      status: entry.status,
      updated_at: payload.updated_at,
    });
  }
  if (change.driverId && !queue.some((entry) => entry.driverId === change.driverId)) {
    io.to(`user:${change.driverId}`).emit("queue:position", {
      zone_id: PYATAK_ZONE.id,
      position: null,
      status: "not_in_queue",
      updated_at: payload.updated_at,
    });
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
    io.to(`user:${order.driverId}`).emit("order:status", payload);
  }
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