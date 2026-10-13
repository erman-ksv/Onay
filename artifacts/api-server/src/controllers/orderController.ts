import type { Request, Response } from "express";
import type { Server } from "socket.io";
import { logger } from "../lib/logger";
import { store } from "../store";
import { statusTransitions } from "../store/orderLifecycle";
import type { Coordinates, Order, OrderStatus, PickupPoint } from "../types/domain";
import { SEAT_LOCK_TTL_MS } from "../utils/config";
import { AppError } from "../utils/errors";
import { translate } from "../utils/i18n";
import { emitIncomingOrder, emitOrderUpdate, emitQueueUpdate } from "../utils/realtime";
import { serializeOrder } from "../utils/serialize";
import { calculateRouteFare, parseRouteStopCodes } from "../utils/fare";
import { boundedInteger, optionalString, pickEnum, requiredString } from "../utils/validation";
import { normalizeNaturalLanguageAddress } from "../services/geminiAddressService";

function getSocket(request: Request): Server | undefined {
  return request.app.locals.io as Server | undefined;
}

function getPickupLocation(request: Request): Coordinates {
  const raw = request.body?.pickup_location;
  if (!raw || typeof raw !== "object") {
    throw new AppError(400, "pickup_location is required", "VALIDATION_ERROR");
  }
  const input = raw as Record<string, unknown>;
  return {
    lat: Number(input["lat"]),
    lng: Number(input["lng"]),
    timestamp: input["timestamp"] ? Number(input["timestamp"]) : Date.now(),
    isMocked: input["isMocked"] === true,
  };
}

function assertPassenger(request: Request): string {
  if (!request.auth || request.auth.role !== "passenger") {
    throw new AppError(
      403,
      translate(request.auth?.locale ?? "ru", "passengerOnly"),
      "PASSENGER_ONLY",
    );
  }
  return request.auth.userId;
}

function assertDriver(request: Request): string {
  if (!request.auth || request.auth.role !== "driver") {
    throw new AppError(
      403,
      translate(request.auth?.locale ?? "ru", "driverOnly"),
      "DRIVER_ONLY",
    );
  }
  return request.auth.userId;
}

async function getOrderForActor(request: Request, orderId: string): Promise<Order> {
  const order = await store.getOrder(orderId);
  if (!order) {
    throw new AppError(
      404,
      translate(request.auth?.locale ?? "ru", "orderNotFound"),
      "ORDER_NOT_FOUND",
    );
  }
  const userId = request.auth?.userId;
  if (
    userId !== order.passengerId &&
    userId !== order.driverId &&
    userId !== order.offeredDriverId
  ) {
    throw new AppError(404, "Order not found", "ORDER_NOT_FOUND");
  }
  return order;
}

function sendOrderToDriver(io: Server | undefined, order: Order, driverId: string): void {
  emitIncomingOrder(io, driverId, order);
}

export async function createOrder(
  request: Request,
  response: Response,
): Promise<void> {
  const passengerId = assertPassenger(request);
  const pickupPoint = pickEnum(request.body?.pickup_point ?? "C", "pickup_point", [
    "C",
    "D",
  ] as const) as PickupPoint;
  const requestedStops = parseRouteStopCodes(request.body?.route_stops);
  const fare = await calculateRouteFare({
    routeId: request.body?.route_id,
    pickupStop: request.body?.pickup_stop ?? pickupPoint,
    destinationStop: request.body?.destination_stop,
    routeStops: requestedStops.length > 0 ? requestedStops : undefined,
  });
  const pickupAddressText = optionalString(
    request.body?.pickup_address,
    "pickup_address",
    500,
  );
  const pickupAddress = pickupAddressText
    ? await normalizeNaturalLanguageAddress(
        pickupAddressText,
        request.auth?.locale ?? "ru",
      )
    : undefined;
  const order = await store.createOrder({
    passengerId,
    passengerPhone: request.auth?.user.phoneNumber ?? "",
    pickupPoint,
    pickupLocation: getPickupLocation(request),
    pickupAddress,
    routeStops: fare.stops,
    fare,
    destination: requiredString(request.body?.destination, "destination", 240),
    seats: boundedInteger(request.body?.seats ?? 1, "seats", 1, 8),
    status: "searching",
  });

  const firstDriver =
    pickupPoint === "D"
      ? await store.getFirstEligibleDriver(order.seats)
      : (await store.getQueue())[0];
  if (firstDriver) {
    await store.updateOrder(order.id, { offeredDriverId: firstDriver.driverId });
    order.offeredDriverId = firstDriver.driverId;
    sendOrderToDriver(getSocket(request), order, firstDriver.driverId);
  }

  response.status(201).json({
    order: serializeOrder(order),
    offer: firstDriver
      ? {
          driver_id: firstDriver.driverId,
          queue_position: await store.getQueuePosition(firstDriver.driverId),
          smart_pooling: pickupPoint === "D",
        }
      : null,
  });
}

export async function listOrders(request: Request, response: Response): Promise<void> {
  const orders = (await store.listOrdersForUser(request.auth?.userId ?? "")).map((order) =>
    serializeOrder(order, request.auth?.role === "driver"),
  );
  response.json({ orders });
}

export async function getOrder(request: Request, response: Response): Promise<void> {
  const order = await getOrderForActor(request, String(request.params["orderId"]));
  response.json({
    order: serializeOrder(order, request.auth?.role === "driver"),
  });
}

export async function acceptOrder(request: Request, response: Response): Promise<void> {
  const driverId = assertDriver(request);
  const order = await store.getOrder(String(request.params["orderId"]));
  if (!order) {
    throw new AppError(
      404,
      translate(request.auth?.locale ?? "ru", "orderNotFound"),
      "ORDER_NOT_FOUND",
    );
  }
  if (order.status !== "searching" || (order.driverId && order.driverId !== driverId)) {
    throw new AppError(409, "Order is no longer available", "ORDER_UNAVAILABLE");
  }
  if (order.offeredDriverId && order.offeredDriverId !== driverId) {
    throw new AppError(409, "Order is reserved for another driver", "ORDER_RESERVED");
  }

  const queueEntry = await store.getQueueEntry(driverId);
  const position = await store.getQueuePosition(driverId);
  const isActivePoolOffer =
    order.pickupPoint === "D" &&
    order.offeredDriverId === driverId &&
    queueEntry?.inFifo === false &&
    queueEntry.status === "in_transit";
  if (!queueEntry || (!isActivePoolOffer && position !== 1)) {
    throw new AppError(409, "Only the first driver in the queue can accept this order", "FIFO_REQUIRED");
  }
  if (queueEntry.availableSeats < order.seats) {
    throw new AppError(409, "Not enough available seats", "SEATS_UNAVAILABLE");
  }

  const seatLockExpiresAt =
    order.pickupPoint === "C" ? Date.now() + SEAT_LOCK_TTL_MS : undefined;
  const status: OrderStatus = order.pickupPoint === "C" ? "en_route_to_c" : "in_transit";
  const updated = await store.claimOrderForDriver(
    order.id,
    driverId,
    { status, seatLockExpiresAt },
    {}, // The store derives reservation fields from the queue under its lock.
  );
  if (!updated) {
    throw new AppError(409, "Order is no longer available", "ORDER_UNAVAILABLE");
  }
  if (seatLockExpiresAt) {
    setTimeout(() => {
      void (async () => {
        await store.clearExpiredSeatLocks();
        await emitQueueUpdate(getSocket(request), {
          type: "seat_lock_expired",
          driverId,
        });
      })().catch((err) => logger.error({ err, driverId }, "Seat-lock expiration failed"));
    }, SEAT_LOCK_TTL_MS + 100);
  }

  emitOrderUpdate(getSocket(request), updated);
  await emitQueueUpdate(getSocket(request), {
    type: "order_assigned",
    driverId,
  });
  response.json({
    message: translate(request.auth?.locale ?? "ru", "seatLocked"),
    order: serializeOrder(updated, true),
    seat_lock_minutes: order.pickupPoint === "C" ? 7 : null,
  });
}

export async function updateOrderStatus(request: Request, response: Response): Promise<void> {
  const driverId = assertDriver(request);
  const order = await getOrderForActor(request, String(request.params["orderId"]));
  if (order.driverId !== driverId) {
    throw new AppError(403, "Only the assigned driver can update this order", "NOT_ASSIGNED");
  }
  const nextStatus = pickEnum(
    request.body?.status,
    "status",
    ["en_route_to_c", "arrived_at_c", "in_transit", "completed", "cancelled"] as const,
  ) as OrderStatus;
  if (!statusTransitions[order.status].includes(nextStatus)) {
    throw new AppError(
      409,
      translate(request.auth?.locale ?? "ru", "invalidStatus"),
      "INVALID_STATUS_TRANSITION",
    );
  }

  const updated = await store.transitionOrder(order.id, driverId, nextStatus, order.status);
  if (!updated) {
    throw new AppError(409, "Order changed before the status update", "ORDER_UNAVAILABLE");
  }

  emitOrderUpdate(getSocket(request), updated);
  await emitQueueUpdate(getSocket(request), {
    type: "order_released",
    driverId,
  });
  response.json({ order: serializeOrder(updated, true) });
}

export async function cancelOrder(request: Request, response: Response): Promise<void> {
  const order = await getOrderForActor(request, String(request.params["orderId"]));
  if (order.status === "completed" || order.status === "cancelled") {
    throw new AppError(409, "Order is already closed", "ORDER_CLOSED");
  }
  const updated = await store.transitionOrder(order.id, request.auth?.userId ?? "", "cancelled", order.status);
  if (!updated) {
    throw new AppError(409, "Order changed before cancellation", "ORDER_UNAVAILABLE");
  }
  emitOrderUpdate(getSocket(request), updated);
  await emitQueueUpdate(getSocket(request), {
    type: "order_released",
    driverId: order.driverId,
  });
  response.json({ order: serializeOrder(updated, request.auth?.role === "driver") });
}

export async function offerToFirstDriver(request: Request, response: Response): Promise<void> {
  const driverId = assertDriver(request);
  const order = await getOrderForActor(request, String(request.params["orderId"]));
  if (order.pickupPoint !== "D" || order.status !== "searching") {
    throw new AppError(409, "Only searching Point D orders can be pooled", "NOT_POOLING_ORDER");
  }
  const firstDriver = await store.getFirstEligibleDriver(order.seats);
  if (!firstDriver || firstDriver.driverId !== driverId) {
    throw new AppError(409, "You are not the eligible first driver", "FIFO_REQUIRED");
  }
  await store.updateOrder(order.id, { offeredDriverId: driverId });
  order.offeredDriverId = driverId;
  sendOrderToDriver(getSocket(request), order, driverId);
  response.json({ order: serializeOrder(order, true), smart_pooling: true });
}
