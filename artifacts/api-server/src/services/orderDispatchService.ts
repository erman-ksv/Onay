import type { Server } from "socket.io";
import { logger } from "../lib/logger";
import { store } from "../store";
import type { OrderOfferChange } from "../types/domain";
import {
  emitDriverOrderUpdate,
  emitIncomingOrder,
  emitOrderOfferWithdrawn,
  emitOrderUpdate,
  emitQueueUpdate,
} from "../utils/realtime";

/** Realtime delivery follows the store commit; notification failures never undo it. */
export async function publishOrderOfferChanges(
  io: Server | undefined,
  changes: readonly OrderOfferChange[],
): Promise<void> {
  if (changes.length === 0) return;
  for (const change of changes) {
    try {
      if (change.previousDriverId && (change.order.status !== "searching" ||
          change.previousDriverId !== change.order.offeredDriverId)) {
        emitOrderOfferWithdrawn(io, change.previousDriverId, change.order);
      }
      emitOrderUpdate(io, change.order);
      if (
        change.order.status === "searching" &&
        change.order.offeredDriverId &&
        (change.order.offerExpiresAt ?? 0) > Date.now()
      ) {
        emitIncomingOrder(io, change.order.offeredDriverId, change.order);
      }
    } catch (err) {
      logger.error({ err, orderId: change.order.id }, "Committed order-offer notification failed");
    }
  }
  try {
    await emitQueueUpdate(io, { type: "order_offer" });
  } catch (err) {
    logger.error({ err }, "Committed order-offer queue notification failed");
  }
}

let currentSweep: Promise<void> | undefined;
let anotherSweepRequested = false;

/** Durable deadlines are checked at startup, every second, and after availability changes. */
export async function processOrderDispatch(io: Server | undefined): Promise<void> {
  anotherSweepRequested = true;
  if (currentSweep) return currentSweep;
  currentSweep = (async () => {
    try {
      do {
        anotherSweepRequested = false;
        const now = Date.now();
        const expiringOrders = (await store.listOrders())
          .filter((order) => order.status === "en_route_to_c" &&
            order.seatLockExpiresAt !== undefined && order.seatLockExpiresAt <= now)
          .map((order) => ({ orderId: order.id, driverId: order.driverId }));
        await store.clearExpiredSeatLocks();
        // Cleanup may have raced another instance. Notify only the observed reopened state.
        let seatLocksChanged = false;
        for (const expired of expiringOrders) {
          const reopened = await store.getOrder(expired.orderId);
          if (reopened?.status === "searching" && !reopened.driverId && !reopened.seatLockExpiresAt) {
            emitOrderUpdate(io, reopened);
            if (expired.driverId) emitDriverOrderUpdate(io, expired.driverId, reopened);
            seatLocksChanged = true;
          }
        }
        const changes = await store.processOrderOffers(Date.now());
        await publishOrderOfferChanges(io, changes);
        if (seatLocksChanged && changes.length === 0) {
          await emitQueueUpdate(io, { type: "seat_lock_expired" });
        }
      } while (anotherSweepRequested);
    } catch (err) {
      logger.error({ err }, "Durable order-offer and seat-lock sweep failed");
    } finally {
      currentSweep = undefined;
    }
  })();
  return currentSweep;
}
