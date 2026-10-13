import type { Request, Response } from "express";
import { store } from "../store";
import type { Coordinates, DriverQueueStatus } from "../types/domain";
import { PYATAK_ZONE, REQUIRE_DRIVER_APPROVAL } from "../utils/config";
import { isWithinRadius } from "../utils/geo";
import { AppError } from "../utils/errors";
import { translate } from "../utils/i18n";
import { emitQueueUpdate } from "../utils/realtime";
import { boundedInteger, pickEnum } from "../utils/validation";

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
    REQUIRE_DRIVER_APPROVAL &&
    request.auth.user.driverApprovalStatus !== "approved"
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
  response.json({
    zone: {
      id: PYATAK_ZONE.id,
      name: PYATAK_ZONE.name,
      center: PYATAK_ZONE.center,
      geofence_meters: PYATAK_ZONE.radiusMeters,
    },
    queue_point: PYATAK_ZONE.center,
    geofence_meters: PYATAK_ZONE.radiusMeters,
    queue: await store.queueSnapshot(),
    your_position: request.auth
      ? await store.getQueuePosition(request.auth.userId)
      : null,
  });
}

export async function joinQueue(request: Request, response: Response): Promise<void> {
  const driverId = assertDriver(request);
  const location = getLocation(request);
  if (!isWithinRadius(location, PYATAK_ZONE.center, PYATAK_ZONE.radiusMeters)) {
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
  if (existing && existing.inFifo === false) {
    throw new AppError(
      409,
      "Driver is already on an active route",
      "ACTIVE_ROUTE",
    );
  }
  const entry = await store.joinQueue({
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
  });
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

export async function leaveQueue(request: Request, response: Response): Promise<void> {
  const driverId = assertDriver(request);
  const entry = await store.getQueueEntry(driverId);
  if (entry?.currentOrderId) {
    throw new AppError(
      409,
      "Driver cannot leave the queue while an order is active",
      "ACTIVE_ORDER",
    );
  }
  await store.leaveQueue(driverId);
  await emitQueueUpdate(request.app.locals.io, { type: "left", driverId });
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
    current.status === "searching" &&
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
  response.json({ entry, position: await store.getQueuePosition(driverId) });
}