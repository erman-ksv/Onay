import { hasRequiredDriverApproval } from "../utils/driverVehicle";
import type { Request, Response } from "express";
import { store } from "../store";
import type { Coordinates, DriverQueueStatus } from "../types/domain";
import { PYATAK_ZONE, REQUIRE_DRIVER_APPROVAL } from "../utils/config";
import { isWithinRadius } from "../utils/geo";
import { AppError } from "../utils/errors";
import { translate } from "../utils/i18n";
import { emitOrderUpdate, emitQueueUpdate } from "../utils/realtime";
import { boundedInteger, pickEnum, requiredString } from "../utils/validation";
import { processOrderDispatch } from "../services/orderDispatchService";
import { readDriverRouteChoiceInput } from "../utils/driverRoute";
import { queueStatusView } from "../services/queueView";
import { serializeOrder } from "../utils/serialize";
import { logger } from "../lib/logger";

function getLocation(request: Request): Coordinates {
  const raw = request.body?.location;
  if (!raw || typeof raw !== "object") {
    throw new AppError(400, "location is required", "VALIDATION_ERROR");
  }
  const input = raw as Record<string, unknown>;
  return {
    lat: Number(input["lat"]),
    lng: Number(input["lng"]),
    timestamp: input["timestamp"] ? Number(input["timestamp"]) : Date.now(),
    isMocked: input["isMocked"] === true,
  };
}

function assertDriver(request: Request): string {
  if (!request.auth || request.auth.role !== "driver") {
    throw new AppError(
      403,
      translate(request.auth?.locale ?? "ru", "driverOnly"),
      "DRIVER_ONLY",
    );
  }
  if (
    !hasRequiredDriverApproval(request.auth.user, REQUIRE_DRIVER_APPROVAL)
  ) {
    throw new AppError(
      403,
      "Driver approval is required before joining the queue",
      "DRIVER_NOT_APPROVED",
    );
  }
  return request.auth.userId;
}

export async function getQueueStatus(request: Request, response: Response): Promise<void> {
  response.json(await queueStatusView(request.auth?.user));
}

export async function joinQueue(request: Request, response: Response): Promise<void> {
  await joinQueueWithMode(request, response, false);
}

/** The new driver action opts into collection without changing existing clients. */
export async function joinLine(request: Request, response: Response): Promise<void> {
  await joinQueueWithMode(request, response, true);
}

async function joinQueueWithMode(request: Request, response: Response, collectionMode: boolean): Promise<void> {
  const driverId = assertDriver(request);
  if (Object.keys(request.body ?? {}).some(key => !["location", "available_seats", "route_choice"].includes(key))) {
    throw new AppError(400, "Unsupported queue field", "VALIDATION_ERROR");
  }
  const selection = request.body?.route_choice === undefined ? undefined : readDriverRouteChoiceInput(request.body.route_choice);
  if (collectionMode && !selection) {
    throw new AppError(400, "A configured route choice is required", "VALIDATION_ERROR");
  }
  const location = getLocation(request);
  if (!selection && !isWithinRadius(location, PYATAK_ZONE.center, PYATAK_ZONE.radiusMeters)) {
    throw new AppError(
      422,
      translate(request.auth?.locale ?? "ru", "outsideGeofence"),
      "OUTSIDE_QUEUE_GEOFENCE",
    );
  }

  const availableSeats = boundedInteger(
    request.body?.available_seats ?? 3,
    "available_seats",
    1,
    8,
  );
  const existing = await store.getQueueEntry(driverId);
  if (existing?.pendingOfferOrderId) {
    throw new AppError(409, "Driver has a pending order offer", "QUEUE_BUSY");
  }
  if (existing && existing.inFifo === false) {
    throw new AppError(
      409,
      "Driver is already on an active route",
      "ACTIVE_ROUTE",
    );
  }
  await store.joinQueue({
    driverId,
    joinedAt: existing?.joinedAt ?? Date.now(),
    status: existing?.status ?? "searching",
    availableSeats,
    lastLocation: location,
    priorityLock: existing?.priorityLock ?? false,
    inFifo: true,
    activeOrderIds: existing?.activeOrderIds,
    currentOrderId: existing?.currentOrderId,
    seatLockExpiresAt: existing?.seatLockExpiresAt,
  }, request.auth?.user.sessionVersion, selection, collectionMode);
  await processOrderDispatch(request.app.locals.io);
  const entry = await store.getQueueEntry(driverId);
  await emitQueueUpdate(request.app.locals.io, {
    type: existing ? "reordered" : "joined",
    driverId,
  });
  response.status(201).json({
    message: translate(request.auth?.locale ?? "ru", "queueJoined"),
    entry,
    position: await store.getQueuePosition(driverId),
  });
}

/** A trip-level command; the store commits the queue and boarded orders together. */
export async function departQueue(request: Request, response: Response): Promise<void> {
  const driverId = assertDriver(request);
  const body = request.body;
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).some(key => key !== "expected_enrollment_id")) {
    throw new AppError(400, "Expected only expected_enrollment_id", "VALIDATION_ERROR");
  }
  const enrollmentId = requiredString(body.expected_enrollment_id, "expected_enrollment_id", 64);
  const result = await store.departQueue(driverId, enrollmentId, request.auth?.user.sessionVersion);
  if (result.changed) {
    try {
      for (const order of result.orders) emitOrderUpdate(request.app.locals.io, order);
      await emitQueueUpdate(request.app.locals.io, { type: "departed", driverId });
    } catch (err) {
      logger.error({ err, driverId }, "Committed departure notification failed");
    }
    await processOrderDispatch(request.app.locals.io);
  }
  response.json({
    entry: result.entry,
    orders: result.orders.map(order => serializeOrder(order, true)),
    changed: result.changed,
    position: null,
  });
}

export async function leaveQueue(request: Request, response: Response): Promise<void> {
  const driverId = assertDriver(request);
  const entry = await store.getQueueEntry(driverId);
  if (entry?.currentOrderId || entry?.activeOrderIds?.length || entry?.pendingOfferOrderId) {
    throw new AppError(
      409,
      "Driver cannot leave the queue while an order is active",
      "ACTIVE_ORDER",
    );
  }
  await store.leaveQueue(driverId);
  await emitQueueUpdate(request.app.locals.io, { type: "left", driverId });
  await processOrderDispatch(request.app.locals.io);
  response.status(204).send();
}

export async function updateQueueLocation(request: Request, response: Response): Promise<void> {
  const driverId = assertDriver(request);
  const location = getLocation(request);
  const current = await store.getQueueEntry(driverId);
  if (!current) {
    throw new AppError(404, "Driver is not in the queue", "NOT_IN_QUEUE");
  }
  if (
    !current.routeContext && current.status === "searching" &&
    !isWithinRadius(location, PYATAK_ZONE.center, PYATAK_ZONE.radiusMeters)
  ) {
    throw new AppError(
      422,
      translate(request.auth?.locale ?? "ru", "outsideGeofence"),
      "OUTSIDE_QUEUE_GEOFENCE",
    );
  }
  const entry = await store.updateQueueEntry(driverId, { lastLocation: location });
  if (!entry) {
    throw new AppError(404, "Driver is not in the queue", "NOT_IN_QUEUE");
  }
  await emitQueueUpdate(request.app.locals.io, { type: "location", driverId });
  response.json({ entry, position: await store.getQueuePosition(driverId) });
}

export async function updateQueueStatus(request: Request, response: Response): Promise<void> {
  const driverId = assertDriver(request);
  const status = pickEnum(
    request.body?.status,
    "status",
    ["searching", "picking_up", "en_route_to_c", "arrived_at_c", "in_transit"] as const,
  ) as DriverQueueStatus;
  const current = await store.getQueueEntry(driverId);
  if (!current) {
    throw new AppError(404, "Driver is not in the queue", "NOT_IN_QUEUE");
  }
  if (current.pendingOfferOrderId) {
    throw new AppError(409, "Accept or reject the pending offer before changing status", "QUEUE_BUSY");
  }
  if (current.routeContext) {
    throw new AppError(409, "Use the assigned order lifecycle to change configured trip status", "ROUTE_DISPATCH_NOT_AVAILABLE");
  }
  const allowedTransitions: Record<DriverQueueStatus, readonly DriverQueueStatus[]> = {
    searching: ["picking_up", "in_transit"],
    picking_up: ["searching", "en_route_to_c"],
    en_route_to_c: ["arrived_at_c", "searching"],
    arrived_at_c: ["in_transit", "searching"],
    in_transit: ["searching", "in_transit"],
  };
  if (!allowedTransitions[current.status].includes(status)) {
    throw new AppError(409, "Invalid queue status transition", "INVALID_QUEUE_STATUS");
  }
  const entry = await store.updateQueueEntry(driverId, {
    status,
    priorityLock:
      status === "picking_up" ||
      status === "en_route_to_c" ||
      status === "arrived_at_c" ||
      status === "in_transit",
    inFifo:
      status === "in_transit"
        ? false
        : status === "searching"
          ? true
          : current.inFifo !== false,
  });
  if (!entry) {
    throw new AppError(404, "Driver is not in the queue", "NOT_IN_QUEUE");
  }
  await emitQueueUpdate(request.app.locals.io, { type: "status", driverId });
  await processOrderDispatch(request.app.locals.io);
  response.json({ entry: await store.getQueueEntry(driverId), position: await store.getQueuePosition(driverId) });
}
