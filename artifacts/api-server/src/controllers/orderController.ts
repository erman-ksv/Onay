import { publicDriverVehicle } from "../utils/driverVehicle";
import type { NextFunction, Request, Response } from "express";
import { randomUUID } from "node:crypto";
import type { Server } from "socket.io";
import { store } from "../store";
import { statusTransitions } from "../store/orderLifecycle";
import type { Coordinates, Order, OrderStatus, PickupPoint } from "../types/domain";
import { AppError } from "../utils/errors";
import { translate } from "../utils/i18n";
import { emitOrderUpdate, emitQueueUpdate } from "../utils/realtime";
import { serializeOrder } from "../utils/serialize";
import { calculateRouteFare, parseRouteStopCodes } from "../utils/fare";
import { boundedInteger, optionalString, pickEnum, requiredString } from "../utils/validation";
import { normalizeNaturalLanguageAddress } from "../services/geminiAddressService";
import { processOrderDispatch, publishOrderOfferChanges } from "../services/orderDispatchService";
import type { RouteOrderSelectionInput } from "../store/storeContract";
import { driverRouteOption, readDriverRouteChoiceInput } from "../utils/driverRoute";
import { isValidCoordinates } from "../utils/geo";
import { validateRouteOrderSelectionInput } from "../utils/routeOrder";
import { assertRouteOrderRequestHash, requireRouteOrderRequestKey, routeOrderRequestHash } from "../utils/routeOrderRequest";
import { logger } from "../lib/logger";
import { routePricePerStop } from "../utils/routePricing";
import { publicExternalSettings } from "../utils/externalMoney";

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

function routeOrderRecord(value: unknown, allowedFields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError(400, "Route order fields must be an object", "VALIDATION_ERROR");
  }
  const fields = value as Record<string, unknown>;
  if (Object.keys(fields).some(key => !allowedFields.includes(key))) {
    throw new AppError(400, "Route order contains an unsupported field", "VALIDATION_ERROR");
  }
  return fields;
}

function readRouteOrderSelection(fields: Record<string, unknown>): RouteOrderSelectionInput {
  return validateRouteOrderSelectionInput({
    ...readDriverRouteChoiceInput({
      route_id: fields.route_id,
      direction: fields.direction,
      expected_updated_at: fields.expected_updated_at,
    }),
    pickupStopId: fields.pickup_stop_id as string | undefined,
    destinationStopId: fields.destination_stop_id as string | undefined,
  });
}

function readRouteOrderLocation(value: unknown): Coordinates {
  const fields = routeOrderRecord(value, ["lat", "lng", "timestamp", "isMocked"]);
  if (typeof fields.lat !== "number" || typeof fields.lng !== "number" ||
      (fields.timestamp !== undefined && (typeof fields.timestamp !== "number" ||
        !Number.isFinite(fields.timestamp) || fields.timestamp <= 0))) {
    throw new AppError(422, "Valid numeric pickup coordinates are required", "INVALID_COORDINATES");
  }
  if (fields.isMocked !== undefined && typeof fields.isMocked !== "boolean") {
    throw new AppError(400, "isMocked must be a boolean", "VALIDATION_ERROR");
  }
  const location: Coordinates = {
    lat: fields.lat,
    lng: fields.lng,
    timestamp: fields.timestamp === undefined ? Date.now() : fields.timestamp as number,
    isMocked: fields.isMocked === true,
  };
  if (!isValidCoordinates(location)) {
    throw new AppError(422, "Invalid pickup coordinates", "INVALID_COORDINATES");
  }
  return location;
}

function readRouteOrderBody(request: Request) {
  const fields = routeOrderRecord(request.body,
    ["route_id", "direction", "expected_updated_at", "pickup_stop_id", "destination_stop_id", "pickup_location", "seats"]);
  if (fields.seats !== undefined && typeof fields.seats !== "number") {
    throw new AppError(400, "seats must be a number", "VALIDATION_ERROR");
  }
  return {
    selection: readRouteOrderSelection(fields),
    pickupLocation: readRouteOrderLocation(fields.pickup_location),
    seats: boundedInteger(fields.seats === undefined ? 1 : fields.seats, "seats", 1, 8),
  };
}

/** Validate the new contract before GPS middleware reads or persists any location. */
export function validateRouteOrderRequest(request: Request, _response: Response, next: NextFunction): void {
  readRouteOrderBody(request);
  if (request.headers["idempotency-key"] !== undefined) requireRouteOrderRequestKey(request.headers["idempotency-key"]);
  next();
}

async function sendRouteOrder(response: Response, order: Order, replayed?: boolean): Promise<void> {
  response.set("Cache-Control", "no-store").status(replayed === true ? 200 : 201).json({
    order: serializeOrder(order),
    offer: order.offeredDriverId ? {
      driver_id: order.offeredDriverId,
      queue_position: await store.getQueuePosition(order.offeredDriverId),
      smart_pooling: false,
      expires_at: order.offerExpiresAt,
    } : null,
    ...(replayed === undefined ? {} : { replayed }),
  });
}

/** Recover before GPS middleware: reading an existing order must not move the user. */
export async function replayRouteOrderRequest(request: Request, response: Response, next: NextFunction): Promise<void> {
  const header = request.headers["idempotency-key"];
  if (header === undefined) { next(); return; }
  const passengerId = assertPassenger(request);
  const { selection, seats } = readRouteOrderBody(request);
  const receipt = await store.getRouteOrderRequest(passengerId, requireRouteOrderRequestKey(header), request.auth?.user.sessionVersion);
  if (!receipt) { next(); return; }
  assertRouteOrderRequestHash(receipt.requestHash, routeOrderRequestHash(selection, seats));
  await sendRouteOrder(response, receipt.order, true);
}

export async function getRouteOrderRequest(request: Request, response: Response): Promise<void> {
  response.set("Cache-Control", "no-store");
  const passengerId = assertPassenger(request);
  const receipt = await store.getRouteOrderRequest(passengerId,
    requireRouteOrderRequestKey(request.params["requestKey"]), request.auth?.user.sessionVersion);
  if (!receipt) throw new AppError(404, "Booking request was not found", "ORDER_REQUEST_NOT_FOUND");
  // Absence is only a snapshot: an earlier POST may still be in flight.
  response.json({ order: serializeOrder(receipt.order) });
}

/** Resolve transport uncertainty without cancelling an already created ride. */
export async function resolveRouteOrderRequest(request: Request, response: Response): Promise<void> {
  response.set("Cache-Control", "no-store");
  const passengerId = assertPassenger(request);
  if (request.body !== undefined && (request.body === null || typeof request.body !== "object" ||
      Array.isArray(request.body) || Object.keys(request.body).length !== 0)) {
    throw new AppError(400, "Recovery accepts no editable booking fields", "VALIDATION_ERROR");
  }
  const key = requireRouteOrderRequestKey(request.params["requestKey"]);
  const result = await store.resolveRouteOrderRequest(passengerId, key, request.auth?.user.sessionVersion);
  response.json(result.state === "created"
    ? { state: "created", request_key: key, order: serializeOrder(result.order) }
    : { state: "closed", request_key: result.requestKey });
}

/** Mint an unreserved intent ID without requiring a native random-number dependency. */
export function newRouteOrderRequestKey(request: Request, response: Response): void {
  assertPassenger(request);
  response.set("Cache-Control", "no-store").json({ request_key: randomUUID() });
}

export async function listOrderRoutes(request: Request, response: Response): Promise<void> {
  assertPassenger(request);
  const routes = (await store.listRoutes()).flatMap(route => {
    if (route.active !== true) return [];
    const option = driverRouteOption(route);
    if (!option) return [];
    let price: number;
    try { price = routePricePerStop(route); } catch { return []; }
    return [{ ...option, currency: route.currency, pricePerStop: price,
      ...(route.currency === "KZT" ? { pricePerStopKzt: price } : {}),
      ...(route.externalPickup?.enabled ? { external_pickup: publicExternalSettings(route.externalPickup) } : {}),
    }];
  });
  response.json({ routes });
}

export async function getRouteOrderAvailability(request: Request, response: Response): Promise<void> {
  assertPassenger(request);
  const fields = routeOrderRecord(request.query,
    ["route_id", "direction", "expected_updated_at", "pickup_stop_id", "destination_stop_id", "seats"]);
  const selection = readRouteOrderSelection(fields);
  if (fields.seats !== undefined && (typeof fields.seats !== "string" || !/^\d+$/.test(fields.seats))) {
    throw new AppError(400, "seats must be a single integer", "VALIDATION_ERROR");
  }
  const seats = boundedInteger(fields.seats === undefined ? 1 : fields.seats, "seats", 1, 8);
  const availability = await store.getRouteOrderAvailability(selection, seats);
  response.json({
    available: availability.available,
    eligible_driver_count: availability.eligibleDriverCount,
    offer_timeout_seconds: (await store.getOfferTimeout()).seconds,
    fare: availability.fare,
  });
}

export async function createRouteOrder(request: Request, response: Response): Promise<void> {
  const passengerId = assertPassenger(request);
  const { selection, pickupLocation, seats } = readRouteOrderBody(request);
  const input = {
    passengerId,
    passengerPhone: request.auth?.user.phoneNumber ?? "",
    pickupLocation,
    seats,
  };
  const header = request.headers["idempotency-key"];
  const result = header === undefined
    ? undefined
    : await store.createRouteOrderOnce(input, selection, requireRouteOrderRequestKey(header), request.auth?.user.sessionVersion);
  const order = header === undefined
    ? await store.createRouteOrderWithOffer(input, selection, request.auth?.user.sessionVersion)
    : result?.order;
  if (!order) {
    throw new AppError(409, "Водителей пока нет", "NO_DRIVERS");
  }
  if (header === undefined || result?.created) await publishOrderOfferChanges(getSocket(request), [{ order }]);
  await sendRouteOrder(response, order, header === undefined ? undefined : !result?.created);
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

export async function getOrderAvailability(request: Request, response: Response): Promise<void> {
  assertPassenger(request);
  const pickupPoint = pickEnum(request.query["pickup_point"] ?? "C", "pickup_point", ["C", "D"] as const);
  const seats = boundedInteger(request.query["seats"] ?? 1, "seats", 1, 8);
  const availability = await store.getOrderAvailability(pickupPoint, seats);
  response.json({
    available: availability.available,
    eligible_driver_count: availability.eligibleDriverCount,
    offer_timeout_seconds: (await store.getOfferTimeout()).seconds,
  });
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
  const order = await store.createOrderWithOffer({
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
  }, request.auth?.user.sessionVersion);

  if (!order) {
    throw new AppError(409, "Водителей пока нет", "NO_DRIVERS");
  }
  await publishOrderOfferChanges(getSocket(request), [{ order }]);
  const offeredOrder = order;

  response.status(201).json({
    order: serializeOrder(offeredOrder),
    offer: offeredOrder.offeredDriverId
      ? {
          driver_id: offeredOrder.offeredDriverId,
          queue_position: await store.getQueuePosition(offeredOrder.offeredDriverId),
          smart_pooling: pickupPoint === "D",
          expires_at: offeredOrder.offerExpiresAt,
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

/** Contact details are scoped to this passenger's current accepted ride.
 * Never serialize the driver's full account or publish contact data to rooms. */
export async function getAssignedDriver(request: Request, response: Response): Promise<void> {
  response.setHeader("Cache-Control", "no-store");
  const order = await store.getOrder(String(request.params["orderId"]));
  if (!order || order.passengerId !== request.auth?.userId) {
    throw new AppError(404, "Order not found", "ORDER_NOT_FOUND");
  }
  const active = (value: Order) => value.passengerId === request.auth?.userId &&
    !!value.driverId && ["en_route_to_c", "arrived_at_c", "boarded_waiting", "in_transit"].includes(value.status);
  if (!active(order)) throw new AppError(404, "Driver contact is unavailable", "DRIVER_CONTACT_UNAVAILABLE");
  const driver = await store.getUser(order.driverId!);
  // Recheck after the account read: a cancellation or reassignment must not
  // turn an earlier assignment into permission to disclose contact details.
  const current = await store.getOrder(order.id);
  if (!driver || !driver.roles.includes("driver") || !current || !active(current) || current.driverId !== driver.id) {
    throw new AppError(404, "Driver contact is unavailable", "DRIVER_CONTACT_UNAVAILABLE");
  }
  response.json({ driver: { id: driver.id, full_name: driver.fullName, phone_number: driver.phoneNumber,
    ...(driver.driverVehicle && driver.driverApprovalStatus === "approved" ? { vehicle: publicDriverVehicle(driver.driverVehicle) } : {}),
  } });
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
  if (order.offeredDriverId && order.offeredDriverId !== driverId) {
    throw new AppError(409, "Order is reserved for another driver", "ORDER_RESERVED");
  }
  const updated = await store.acceptOrderOffer(order.id, driverId, undefined, request.auth?.user.sessionVersion);
  if (!updated) {
    if (order.externalPickup) {
      const reopened = await store.getOrder(order.id);
      if (reopened?.status === "searching" && !reopened.driverId && !reopened.offeredDriverId &&
          reopened.externalPickup?.requiresPriceConfirmation) {
        await publishOrderOfferChanges(getSocket(request), [{ order: reopened, previousDriverId: driverId }]);
      }
    }
    throw new AppError(409, "Order is no longer available", "ORDER_UNAVAILABLE");
  }
  emitOrderUpdate(getSocket(request), updated);
  await emitQueueUpdate(getSocket(request), {
    type: "order_assigned",
    driverId,
  });
  await processOrderDispatch(getSocket(request));
  response.json({
    message: translate(request.auth?.locale ?? "ru", "seatLocked"),
    order: serializeOrder(updated, true),
    seat_lock_minutes: updated.externalPickup ? null : order.pickupPoint !== "D" ? 7 : null,
    ...(updated.externalPickup ? {
      pickup_wait_seconds: updated.externalPickup.roadDurationSeconds + updated.externalPickup.settings.pickupGraceSeconds,
    } : {}),
  });
}

export async function rejectOrder(request: Request, response: Response): Promise<void> {
  const driverId = assertDriver(request);
  const orderId = String(request.params["orderId"]);
  if (!(await store.getOrder(orderId))) {
    throw new AppError(404, "Order not found", "ORDER_NOT_FOUND");
  }
  const change = await store.rejectOrderOffer(orderId, driverId, undefined, request.auth?.user.sessionVersion);
  if (!change) {
    throw new AppError(409, "Order offer is no longer available", "ORDER_UNAVAILABLE");
  }
  await publishOrderOfferChanges(getSocket(request), [change]);
  await processOrderDispatch(getSocket(request));
  response.json({ order: serializeOrder(change.order, true) });
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

  const updated = await store.transitionOrder(order.id, driverId, nextStatus, order.status, request.auth?.user.sessionVersion);
  if (!updated) {
    throw new AppError(409, "Order changed before the status update", "ORDER_UNAVAILABLE");
  }

  emitOrderUpdate(getSocket(request), updated);
  await emitQueueUpdate(getSocket(request), {
    type: "order_released",
    driverId,
  });
  await processOrderDispatch(getSocket(request));
  response.json({ order: serializeOrder(updated, true) });
}

/** Boarding holds the existing seat reservation while the driver waits to depart. */
export async function boardOrder(request: Request, response: Response): Promise<void> {
  const driverId = assertDriver(request);
  if (request.body !== undefined && (request.body === null || typeof request.body !== "object" ||
      Array.isArray(request.body) || Object.keys(request.body).length > 0)) {
    throw new AppError(400, "Boarding accepts no editable order fields", "VALIDATION_ERROR");
  }
  const order = await getOrderForActor(request, String(request.params["orderId"]));
  if (order.driverId !== driverId) {
    throw new AppError(403, "Only the assigned driver can board this passenger", "NOT_ASSIGNED");
  }
  const updated = await store.transitionOrder(order.id, driverId, "boarded_waiting", order.status, request.auth?.user.sessionVersion);
  if (!updated) throw new AppError(409, "Order changed before boarding", "ORDER_UNAVAILABLE");
  try {
    emitOrderUpdate(getSocket(request), updated);
    await emitQueueUpdate(getSocket(request), { type: "passenger_boarded", driverId });
  } catch (err) {
    logger.error({ err, orderId: order.id }, "Committed boarding notification failed");
  }
  await processOrderDispatch(getSocket(request));
  response.json({ order: serializeOrder(updated, true) });
}

export async function cancelOrder(request: Request, response: Response): Promise<void> {
  const order = await getOrderForActor(request, String(request.params["orderId"]));
  if (order.status === "searching" && order.offerExpiresAt !== undefined &&
      request.auth?.role === "driver" && order.offeredDriverId === request.auth.userId) {
    throw new AppError(409, "Use the reject endpoint to decline a pending offer", "USE_REJECT");
  }
  if (order.status === "completed" || order.status === "cancelled") {
    throw new AppError(409, "Order is already closed", "ORDER_CLOSED");
  }
  const updated = await store.transitionOrder(order.id, request.auth?.userId ?? "", "cancelled", order.status, request.auth?.user.sessionVersion);
  if (!updated) {
    throw new AppError(409, "Order changed before cancellation", "ORDER_UNAVAILABLE");
  }
  const previousOfferedDriverId = updated.offeredDriverId ??
    (order.status === "searching" ? order.offeredDriverId : undefined);
  if (!updated.driverId && previousOfferedDriverId) {
    await publishOrderOfferChanges(getSocket(request), [{
      order: updated,
      previousDriverId: previousOfferedDriverId,
    }]);
  } else {
    emitOrderUpdate(getSocket(request), updated);
    await emitQueueUpdate(getSocket(request), {
      type: "order_released",
      driverId: updated.driverId,
    });
  }
  await processOrderDispatch(getSocket(request));
  response.json({ order: serializeOrder(updated, request.auth?.role === "driver") });
}

export async function offerToFirstDriver(request: Request, response: Response): Promise<void> {
  const driverId = assertDriver(request);
  const order = await getOrderForActor(request, String(request.params["orderId"]));
  if (order.pickupPoint !== "D" || order.status !== "searching") {
    throw new AppError(409, "Only searching Point D orders can be pooled", "NOT_POOLING_ORDER");
  }
  const change = await store.dispatchOrderOffer(order.id);
  await publishOrderOfferChanges(getSocket(request), change ? [change] : []);
  const offeredOrder = change?.order ?? (await store.getOrder(order.id));
  if (!offeredOrder || offeredOrder.offeredDriverId !== driverId ||
      (offeredOrder.offerExpiresAt ?? 0) <= Date.now()) {
    throw new AppError(409, "You are not the eligible first driver", "FIFO_REQUIRED");
  }
  response.json({ order: serializeOrder(offeredOrder, true), smart_pooling: true });
}
