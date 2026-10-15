import type { Order, QueueEntry, RouteDefinition } from "../types/domain";
import { claimQueueEntry, hasActiveOrders } from "./orderLifecycle";
import { AppError } from "../utils/errors";
import { routeOrderIsCurrent } from "../utils/routeOrder";
import { assertRouteQueueLocation, sameQueueLane } from "../utils/routeQueue";

export function compareOfferDrivers(a: QueueEntry, b: QueueEntry): number {
  return Number(!b.routeContext && b.priorityLock) - Number(!a.routeContext && a.priorityLock) ||
    a.joinedAt - b.joinedAt || a.driverId.localeCompare(b.driverId);
}

export function hasLiveOrderOffer(order: Order, now: number): boolean {
  return order.status === "searching" && !order.driverId && Boolean(order.offeredDriverId) &&
    order.offerExpiresAt !== undefined && order.offerExpiresAt > now;
}

/** A configured order must be built from the current catalog in its transaction. */
export function assertLegacyOrderInput(input: Pick<Order, "pickupPoint" | "routeContext">): void {
  if (input.routeContext !== undefined || input.pickupPoint === "A" || input.pickupPoint === "B") {
    throw new AppError(400, "Use the configured route order method", "ROUTE_ORDER_REQUIRED");
  }
}

/** Selection happens while the caller owns the live order and candidate queue rows. */
export function orderedOfferCandidates(
  order: Pick<Order, "pickupPoint" | "seats" | "attemptedDriverIds" | "routeContext">,
  entries: QueueEntry[],
  now: number,
  liveRoute?: RouteDefinition,
): QueueEntry[] {
  if (order.routeContext && !routeOrderIsCurrent(order, liveRoute)) return [];
  const attempted = new Set(order.attemptedDriverIds ?? []);
  return entries.filter(entry => {
    if (attempted.has(entry.driverId) || entry.pendingOfferOrderId || entry.availableSeats < order.seats) {
      return false;
    }
    if (order.routeContext) {
      if (!sameQueueLane(entry.routeContext, order.routeContext) ||
          entry.routeContext?.routeUpdatedAt !== order.routeContext.routeUpdatedAt ||
          entry.status !== "searching" || entry.inFifo === false || hasActiveOrders(entry) ||
          (entry.seatLockExpiresAt !== undefined && entry.seatLockExpiresAt <= now)) return false;
      try {
        assertRouteQueueLocation(order.routeContext, entry.lastLocation);
        return true;
      } catch {
        return false;
      }
    }
    if (entry.routeContext || order.pickupPoint === "A" || order.pickupPoint === "B") return false;
    return order.pickupPoint === "D"
      ? entry.status === "in_transit" && hasActiveOrders(entry)
      : entry.inFifo !== false && (!entry.seatLockExpiresAt || entry.seatLockExpiresAt > now);
  }).sort(order.routeContext
    ? (a, b) => a.joinedAt - b.joinedAt || a.driverId.localeCompare(b.driverId)
    : compareOfferDrivers);
}

export function reserveQueueOffer(entry: QueueEntry, order: Order): QueueEntry {
  if (entry.pendingOfferOrderId || entry.availableSeats < order.seats) {
    throw new AppError(409, "Driver cannot reserve another offer", "OFFER_RESERVED");
  }
  return { ...entry, availableSeats: entry.availableSeats - order.seats, pendingOfferOrderId: order.id };
}

/** Ownership makes repeated rejection, expiry, or cancellation harmless. */
export function releaseQueueOffer(entry: QueueEntry, order: Order): QueueEntry {
  return entry.pendingOfferOrderId === order.id
    ? { ...entry, availableSeats: entry.availableSeats + order.seats, pendingOfferOrderId: undefined }
    : entry;
}

export function acceptQueueOffer(entry: QueueEntry, order: Order): QueueEntry {
  if (entry.pendingOfferOrderId !== order.id) {
    throw new AppError(409, "Driver no longer owns this offer", "OFFER_UNAVAILABLE");
  }
  // claimQueueEntry derives the assigned status/IDs. Its debit is offset here
  // because the same seats were already reserved when the offer was created.
  return {
    ...claimQueueEntry({ ...entry, availableSeats: entry.availableSeats + order.seats }, order),
    pendingOfferOrderId: undefined,
  };
}

/** Generic snapshot patches cannot bypass a real pending seat reservation. */
export function assertOrderOfferPatch(order: Order, patch: Partial<Order>): void {
  if ("routeContext" in patch || (order.routeContext && Object.keys(patch).length > 0)) {
    throw new AppError(409, "Configured order details cannot be changed", "OFFER_RESERVED");
  }
  if (order.status !== "searching" || !order.offeredDriverId || order.offerExpiresAt === undefined) return;
  const guarded = ["offeredDriverId", "offerExpiresAt", "driverId", "status", "seats", "pickupPoint", "attemptedDriverIds"] as const;
  if (guarded.some(key => key in patch && patch[key] !== order[key])) {
    throw new AppError(409, "Use the order offer lifecycle to change a reserved offer", "OFFER_RESERVED");
  }
}

export function assertQueueOfferPatch(entry: QueueEntry, patch: Partial<QueueEntry>): void {
  if (entry.routeContext && entry.inFifo === false && patch.inFifo === true) {
    throw new AppError(409, "Leave and rejoin the configured queue before returning to FIFO", "QUEUE_BUSY");
  }
  if (!entry.pendingOfferOrderId && !(entry.routeContext && hasActiveOrders(entry))) return;
  const guarded = [
    "driverId", "joinedAt", "status", "availableSeats", "priorityLock", "inFifo",
    "activeOrderIds", "currentOrderId", "pendingOfferOrderId", "seatLockExpiresAt",
  ] as const;
  if (guarded.some(key => key in patch && patch[key] !== entry[key])) {
    throw new AppError(409, "Driver cannot change reserved offer state", "OFFER_RESERVED");
  }
}
