import { randomUUID } from "node:crypto";
import type { LineCollectionState, Order, OrderStatus, QueueEntry } from "../types/domain";
import { AppError } from "../utils/errors";

export function isCollecting(entry: Pick<QueueEntry, "collectionState"> | undefined): boolean {
  return entry?.collectionState?.version === 1 && entry.collectionState.phase === "collecting";
}

export function createLineCollectionState(capacity: number, now = Date.now()): LineCollectionState {
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 8) {
    throw new AppError(400, "Line capacity must be an integer between 1 and 8", "VALIDATION_ERROR");
  }
  return { version: 1, enrollmentId: randomUUID(), phase: "collecting", capacity, locationUpdatedAt: now };
}

/** Sorted IDs are the manifest used before locking orders, then rechecked under the queue lock. */
export function lineOrderIds(entry: Pick<QueueEntry, "activeOrderIds" | "currentOrderId">): string[] {
  return [...new Set([...(entry.activeOrderIds ?? []), ...(entry.currentOrderId ? [entry.currentOrderId] : [])])].sort();
}

export function assertLineSeatCount(entry: QueueEntry, availableSeats: number): void {
  const capacity = entry.collectionState?.capacity;
  if (capacity !== undefined && (!Number.isInteger(availableSeats) || availableSeats < 0 || availableSeats > capacity)) {
    throw new AppError(409, "Line seat reservation changed", "QUEUE_BUSY");
  }
}

/** Boarding and an individual order PATCH must never act as the driver's Go command. */
export function assertLineOrderTransition(entry: QueueEntry | undefined, order: Order, nextStatus: OrderStatus, now = Date.now()): void {
  if (nextStatus === "boarded_waiting" && (!entry || !isCollecting(entry) ||
      order.driverId !== entry.driverId || order.status !== "arrived_at_c")) {
    throw new AppError(409, "Boarding is available only while the line is collecting", "BOARDING_NOT_AVAILABLE");
  }
  if (entry && isCollecting(entry) && nextStatus === "in_transit") {
    throw new AppError(409, "Use the driver's departure action to start the line", "DEPART_REQUIRED");
  }
  if (entry?.collectionState && (order.status === "en_route_to_c" || order.status === "arrived_at_c") &&
      nextStatus !== "cancelled" && order.seatLockExpiresAt !== undefined && order.seatLockExpiresAt <= now) {
    throw new AppError(409, "Passenger pickup reservation expired", "PICKUP_EXPIRED");
  }
}

/** A pure transition; stores own the order -> queue -> user transaction boundary. */
export function prepareLineDeparture(
  entry: QueueEntry,
  orders: readonly Order[],
  expectedEnrollmentId: string,
  now = Date.now(),
): { entry: QueueEntry; orders: Order[]; changed: boolean } {
  const state = entry.collectionState;
  if (!state || state.version !== 1 || !entry.routeContext) {
    throw new AppError(409, "Driver is not enrolled in line collection", "LINE_COLLECTION_REQUIRED");
  }
  if (state.enrollmentId !== expectedEnrollmentId) {
    throw new AppError(409, "Queue enrollment changed; reload the current line", "QUEUE_ENROLLMENT_CHANGED");
  }
  if (state.phase === "departed") return { entry, orders: [...orders], changed: false };
  if (state.phase !== "collecting") throw new AppError(409, "Queue state changed", "QUEUE_BUSY");
  if (entry.pendingOfferOrderId) {
    throw new AppError(409, "Accept or reject the pending offer before departure", "QUEUE_BUSY");
  }
  const expectedIds = lineOrderIds(entry);
  const observedIds = orders.map(order => order.id).sort();
  if (expectedIds.length !== observedIds.length || expectedIds.some((id, index) => id !== observedIds[index])) {
    throw new AppError(409, "Line passenger list changed; retry departure", "QUEUE_BUSY");
  }
  for (const order of orders) {
    if (order.driverId !== entry.driverId || !order.routeContext ||
        order.routeContext.routeId !== entry.routeContext.routeId ||
        order.routeContext.direction !== entry.routeContext.direction ||
        !["en_route_to_c", "arrived_at_c", "boarded_waiting"].includes(order.status)) {
      throw new AppError(409, "Line passenger state changed; retry departure", "QUEUE_BUSY");
    }
    if (order.status !== "boarded_waiting" && order.seatLockExpiresAt !== undefined && order.seatLockExpiresAt <= now) {
      throw new AppError(409, "Passenger pickup reservation expired", "PICKUP_EXPIRED");
    }
    if (order.status !== "boarded_waiting" && (order.externalPickup || order.fare.pickupStop.code === order.routeContext.stopCode)) {
      throw new AppError(409, "Passengers at the origin must be boarded or cancelled before departure", "PASSENGERS_NOT_BOARDED");
    }
  }
  assertLineSeatCount(entry, entry.availableSeats);
  const reservedSeats = orders.reduce((sum, order) => sum + order.seats, 0);
  if (reservedSeats + entry.availableSeats !== state.capacity) {
    throw new AppError(409, "Line seat reservation changed", "QUEUE_BUSY");
  }
  const updatedAt = new Date(now).toISOString();
  return {
    entry: {
      ...entry,
      status: "in_transit", inFifo: false, priorityLock: orders.length > 0, seatLockExpiresAt: undefined,
      collectionState: { ...state, phase: "departed", departedAt: now },
    },
    orders: orders.map(order => order.status === "boarded_waiting" ? {
      ...order, status: "in_transit", seatLockExpiresAt: undefined, updatedAt,
    } : order),
    changed: true,
  };
}
