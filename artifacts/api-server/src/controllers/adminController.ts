import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { store } from "../store";
import type { DriverApprovalStatus } from "../types/domain";
import { PYATAK_ZONE, updatePyatakCenter } from "../utils/config";
import { isValidCoordinates } from "../utils/geo";
import { AppError } from "../utils/errors";
import { serializeUser } from "../utils/serialize";
import { boundedInteger, optionalString, pickEnum, requiredString } from "../utils/validation";

function routeId(value: unknown): string {
  const raw = value === undefined ? randomUUID() : requiredString(value, "route_id", 80);
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(raw)) {
    throw new AppError(400, "route_id contains invalid characters", "VALIDATION_ERROR");
  }
  return raw.toLowerCase();
}

function optionalBoolean(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    throw new AppError(400, `${field} must be a boolean`, "VALIDATION_ERROR");
  }
  return value;
}

function readCenter(request: Request): {
  lat: number;
  lng: number;
  timestamp: number;
} {
  const source =
    request.body?.center && typeof request.body.center === "object"
      ? request.body.center
      : request.body;
  const input = source as Record<string, unknown> | undefined;
  const center = {
    lat: Number(input?.lat),
    lng: Number(input?.lng),
    timestamp: Date.now(),
  };
  if (!isValidCoordinates(center)) {
    throw new AppError(
      400,
      "lat and lng must be valid coordinates",
      "INVALID_COORDINATES",
    );
  }
  return center;
}

function serializeQueuePoint() {
  return {
    id: PYATAK_ZONE.id,
    name: PYATAK_ZONE.name,
    center: { ...PYATAK_ZONE.center },
    geofence_meters: PYATAK_ZONE.radiusMeters,
  };
}

export function getQueuePoint(_request: Request, response: Response): void {
  response.json({ queue_point: serializeQueuePoint() });
}

export function updateQueuePoint(request: Request, response: Response): void {
  const center = updatePyatakCenter(readCenter(request));
  response.json({
    message: "Queue point updated",
    queue_point: {
      ...serializeQueuePoint(),
      center,
    },
  });
}

export async function listRoutes(_request: Request, response: Response): Promise<void> {
  response.json({ routes: await store.listRoutes() });
}

export async function createRoute(request: Request, response: Response): Promise<void> {
  let route;
  try {
    route = await store.createRoute({
      id: routeId(request.body?.route_id),
      name: requiredString(request.body?.name, "name", 120),
      pricePerStopKzt: boundedInteger(
        request.body?.price_per_stop ?? 500,
        "price_per_stop",
        0,
        1_000_000_000,
      ),
      active: optionalBoolean(request.body?.active, "active", true),
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("already exists")) {
      throw new AppError(409, "Route already exists", "ROUTE_EXISTS");
    }
    throw error;
  }
  response.status(201).json({ route });
}

export async function updateRoute(request: Request, response: Response): Promise<void> {
  const routeIdParam = requiredString(request.params["routeId"], "route_id", 80);
  const patch: {
    name?: string;
    pricePerStopKzt?: number;
    active?: boolean;
  } = {};
  if (request.body?.name !== undefined) {
    patch.name = requiredString(request.body.name, "name", 120);
  }
  if (request.body?.price_per_stop !== undefined) {
    patch.pricePerStopKzt = boundedInteger(
      request.body.price_per_stop,
      "price_per_stop",
      0,
      1_000_000_000,
    );
  }
  if (request.body?.active !== undefined) {
    patch.active = optionalBoolean(request.body.active, "active", true);
  }
  const route = await store.updateRoute(routeIdParam, patch);
  if (!route) {
    throw new AppError(404, "Route not found", "ROUTE_NOT_FOUND");
  }
  response.json({ route });
}

export async function deleteRoute(request: Request, response: Response): Promise<void> {
  const routeIdParam = requiredString(request.params["routeId"], "route_id", 80);
  if (!(await store.deleteRoute(routeIdParam))) {
    throw new AppError(404, "Route not found", "ROUTE_NOT_FOUND");
  }
  response.status(204).send();
}

export async function addStop(request: Request, response: Response): Promise<void> {
  const route = await store.getRoute(requiredString(request.params["routeId"], "route_id", 80));
  if (!route) {
    throw new AppError(404, "Route not found", "ROUTE_NOT_FOUND");
  }
  const stop = await store.addRouteStop(route.id, {
    code: requiredString(request.body?.code, "code", 40).toUpperCase(),
    name: requiredString(request.body?.name, "name", 120),
    sequence:
      request.body?.sequence === undefined
        ? undefined
        : boundedInteger(request.body.sequence, "sequence", 1, 100_000),
    position:
      request.body?.position === undefined
        ? undefined
        : boundedInteger(request.body.position, "position", 1, 100_000),
  });
  response.status(201).json({ stop });
}

export async function updateStop(request: Request, response: Response): Promise<void> {
  const routeIdParam = requiredString(request.params["routeId"], "route_id", 80);
  const stopId = requiredString(request.params["stopId"], "stop_id", 80);
  const patch: {
    code?: string;
    name?: string;
    sequence?: number;
    position?: number;
  } = {};
  if (request.body?.code !== undefined) {
    patch.code = requiredString(request.body.code, "code", 40).toUpperCase();
  }
  if (request.body?.name !== undefined) {
    patch.name = requiredString(request.body.name, "name", 120);
  }
  if (request.body?.sequence !== undefined) {
    patch.sequence = boundedInteger(request.body.sequence, "sequence", 1, 100_000);
  }
  if (request.body?.position !== undefined) {
    patch.position = boundedInteger(request.body.position, "position", 1, 100_000);
  }
  const stop = await store.updateRouteStop(routeIdParam, stopId, patch);
  if (!stop) {
    throw new AppError(404, "Route stop not found", "STOP_NOT_FOUND");
  }
  response.json({ stop });
}

export async function deleteStop(request: Request, response: Response): Promise<void> {
  const routeIdParam = requiredString(request.params["routeId"], "route_id", 80);
  const stopId = requiredString(request.params["stopId"], "stop_id", 80);
  if (!(await store.deleteRouteStop(routeIdParam, stopId))) {
    throw new AppError(404, "Route stop not found", "STOP_NOT_FOUND");
  }
  response.status(204).send();
}

export async function listDrivers(_request: Request, response: Response): Promise<void> {
  response.json({
    drivers: (await store.listUsers("driver")).map((user) => serializeUser(user)),
  });
}

export async function updateDriverApproval(request: Request, response: Response): Promise<void> {
  const status = pickEnum(
    request.body?.status,
    "status",
    ["pending", "approved", "rejected"] as const,
  ) as DriverApprovalStatus;
  const user = await store.setDriverApproval(
    requiredString(request.params["driverId"], "driver_id", 80),
    status,
  );
  if (!user) {
    throw new AppError(404, "Driver not found", "DRIVER_NOT_FOUND");
  }
  response.json({ driver: serializeUser(user) });
}