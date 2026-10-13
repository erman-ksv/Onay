import type { Order, OrderStatus, QueueEntry } from "../types/domain";

export function hasActiveOrders(entry: QueueEntry): boolean {
  return Boolean(entry.currentOrderId || entry.activeOrderIds?.length);
}

/** Rejoining updates request fields, while queue ownership stays authoritative. */
export function joinQueueEntry(input: QueueEntry, current?: QueueEntry): QueueEntry {
  if (current) {
    return { ...current, availableSeats: input.availableSeats, lastLocation: input.lastLocation };
  }
  return {
    ...input,
    joinedAt: Date.now(),
    status: "searching",
    priorityLock: false,
    inFifo: true,
    activeOrderIds: [],
    currentOrderId: undefined,
    seatLockExpiresAt: undefined,
  };
}

export const statusTransitions: Record<OrderStatus, readonly OrderStatus[]> = {
  searching: ["en_route_to_c", "cancelled"],
  en_route_to_c: ["arrived_at_c", "cancelled"],
  arrived_at_c: ["in_transit", "cancelled"],
  in_transit: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
};

export function canTransitionOrder(
  order: Order,
  actorId: string,
  nextStatus: OrderStatus,
  expectedStatus?: OrderStatus,
): boolean {
  if (!actorId || (expectedStatus !== undefined && order.status !== expectedStatus)) return false;
  if (!statusTransitions[order.status].includes(nextStatus)) return false;
  return nextStatus === "cancelled"
    ? actorId === order.passengerId || actorId === order.driverId || actorId === order.offeredDriverId
    : actorId === order.driverId;
}

export function orderHasReservedSeats(order: Order): boolean {
  return Boolean(order.driverId) &&
    (order.status === "en_route_to_c" || order.status === "arrived_at_c" || order.status === "in_transit");
}

function activeOrderIds(entry: QueueEntry): string[] {
  return entry.activeOrderIds?.length
    ? entry.activeOrderIds
    : entry.currentOrderId ? [entry.currentOrderId] : [];
}

/** Reservation fields are derived from the current queue, never a controller snapshot. */
export function claimQueueEntry(entry: QueueEntry, order: Order): QueueEntry {
  const remainingSeats = entry.availableSeats - order.seats;
  const status = order.pickupPoint === "C" ? "en_route_to_c" : "in_transit";
  return {
    ...entry,
    status,
    priorityLock: true,
    currentOrderId: order.id,
    activeOrderIds: [...new Set([...activeOrderIds(entry), order.id])],
    inFifo: entry.inFifo !== false && status !== "in_transit" && remainingSeats > 0,
    availableSeats: remainingSeats,
    seatLockExpiresAt: order.seatLockExpiresAt,
  };
}

/** Caller must own the order and queue locks until its order transition commits. */
export function releaseQueueEntry(entry: QueueEntry, order: Order): QueueEntry {
  const remaining = activeOrderIds(entry).filter(id => id !== order.id);
  return {
    ...entry,
    status: remaining.length ? "in_transit" : "searching",
    priorityLock: remaining.length > 0,
    inFifo: remaining.length === 0,
    activeOrderIds: remaining,
    currentOrderId: remaining[0],
    seatLockExpiresAt: undefined,
    availableSeats: entry.availableSeats + order.seats,
  };
}

export function transitionQueueEntry(entry: QueueEntry, order: Order, nextStatus: OrderStatus): QueueEntry {
  if (nextStatus === "completed" || nextStatus === "cancelled") {
    return orderHasReservedSeats(order) ? releaseQueueEntry(entry, order) : entry;
  }
  if (nextStatus === "in_transit") {
    return { ...entry, status: "in_transit", priorityLock: true, inFifo: false, seatLockExpiresAt: undefined };
  }
  if (nextStatus === "arrived_at_c" || nextStatus === "en_route_to_c") {
    return { ...entry, status: nextStatus, priorityLock: true };
  }
  return entry;
}
