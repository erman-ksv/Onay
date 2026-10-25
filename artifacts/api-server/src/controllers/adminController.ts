import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { store } from "../store";
import type { DriverApprovalStatus, OrderStatus } from "../types/domain";
import { PYATAK_ZONE, updatePyatakCenter } from "../utils/config";
import { isValidCoordinates } from "../utils/geo";
import { AppError } from "../utils/errors";
import { serializeOrder, serializeUser } from "../utils/serialize";
import { readRouteLayoutInput } from "../utils/routeLayout";
import { boundedInteger, optionalString, pickEnum, requiredString } from "../utils/validation";
import { normalizeExternalPickupSettings } from "../store/externalPickup";
import { processOrderDispatch, publishOrderOfferChanges } from "../services/orderDispatchService";

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

export async function listRoutes(request: Request, response: Response): Promise<void> {
  const active = request.query["active"] === undefined
    ? undefined
    : pickEnum(request.query["active"], "active", ["true", "false"] as const) === "true";
  const routes = await store.listRoutes();
  response.json({
    routes: active === undefined ? routes : routes.filter((route) => route.active === active),
  });
}

/** Read one route and its administrator-configured stops without modifying it. */
export async function getAdminRoute(request: Request, response: Response): Promise<void> {
  const id = requiredString(request.params["routeId"], "route_id", 80);
  const route = await store.getRoute(id);
  if (!route) {
    throw new AppError(404, "Route not found", "ROUTE_NOT_FOUND");
  }
  response.json({ route });
}

export async function updateExternalPickupSettings(request: Request, response: Response): Promise<void> {
  const body = request.body as unknown;
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).some(key => !["expected_updated_at", "settings"].includes(key))) {
    throw new AppError(400, "Invalid external pickup settings request", "VALIDATION_ERROR");
  }
  const input = body as Record<string, unknown>;
  const raw = input.settings;
  const mapping = {
    enabled: "enabled", service_radius_meters: "serviceRadiusMeters", price_per_km_kzt: "pricePerKmKzt",
    gps_max_age_seconds: "gpsMaxAgeSeconds", quote_ttl_seconds: "quoteTtlSeconds",
    pickup_grace_seconds: "pickupGraceSeconds", max_pickup_seconds: "maxPickupSeconds", fare_rounding: "fareRounding",
  } as const;
  if (!raw || typeof raw !== "object" || Array.isArray(raw) ||
      Object.keys(raw).some(key => !Object.hasOwn(mapping, key))) {
    throw new AppError(400, "Invalid external pickup settings", "VALIDATION_ERROR");
  }
  const mapped = Object.fromEntries(Object.entries(raw).map(([key, value]) => [mapping[key as keyof typeof mapping], value]));
  const route = await store.updateExternalPickupSettings(requiredString(request.params["routeId"], "route_id", 80), {
    expectedUpdatedAt: requiredString(input.expected_updated_at, "expected_updated_at", 80),
    settings: normalizeExternalPickupSettings(mapped),
  });
  if (!route) throw new AppError(404, "Route not found", "ROUTE_NOT_FOUND");
  response.json({ route });
}

/** Save the ordered static route geometry and optional endpoint pitaks together. */
export async function updateRouteLayout(request: Request, response: Response): Promise<void> {
  const id = requiredString(request.params["routeId"], "route_id", 80);
  const route = await store.updateRouteLayout(id, readRouteLayoutInput(request.body));
  if (!route) {
    throw new AppError(404, "Route not found", "ROUTE_NOT_FOUND");
  }
  response.json({ route });
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
  const id = requiredString(request.params["routeId"], "route_id", 80);
  const stop = await store.addRouteStop(id, {
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
  if (!stop) {
    throw new AppError(404, "Route not found", "ROUTE_NOT_FOUND");
  }
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

/** Explicit administrator cancellation; storage rechecks authority under its locks. */
export async function cancelAdminOrder(request: Request, response: Response): Promise<void> {
  if (!request.auth || request.auth.role !== "admin") throw new AppError(403, "Administrator role is required", "FORBIDDEN");
  if (!request.body || typeof request.body !== "object" || Array.isArray(request.body) ||
      Object.keys(request.body).some(key => key !== "expected_status")) {
    throw new AppError(400, "Only expected_status is accepted", "VALIDATION_ERROR");
  }
  const expected = pickEnum(request.body.expected_status, "expected_status", [
    "searching", "en_route_to_c", "arrived_at_c", "boarded_waiting", "in_transit", "completed", "cancelled",
  ] as const);
  const id = requiredString(request.params["orderId"], "order_id", 100);
  const before = await store.getOrder(id);
  if (!before) throw new AppError(404, "Order not found", "ORDER_NOT_FOUND");
  const order = await store.cancelOrderAsAdmin(id, request.auth.userId, expected, request.auth.user.sessionVersion);
  if (!order) throw new AppError(409, "Order changed or is already closed", "ORDER_UNAVAILABLE");
  const io = request.app.locals.io;
  await publishOrderOfferChanges(io, [{ order, previousDriverId: order.offeredDriverId }]);
  await processOrderDispatch(io);
  response.set("Cache-Control", "no-store").json({ order: serializeOrder(order) });
}

/** View existing orders without changing dispatch or trip state. */
export async function listAdminOrders(request: Request, response: Response): Promise<void> {
  const status = request.query["status"] === undefined
    ? "all"
    : pickEnum(request.query["status"], "status", [
        "all", "active", "searching", "en_route_to_c", "arrived_at_c", "boarded_waiting",
        "in_transit", "completed", "cancelled",
      ] as const);
  const orders = await store.listOrders();
  const visible = orders.filter((order) =>
    status === "all" ||
    (status === "active"
      ? order.status !== "completed" && order.status !== "cancelled"
      : order.status === status),
  );
  response.json({ orders: visible.map((order) => serializeOrder(order)) });
}

/** Read the current FIFO snapshot without exposing driver GPS or private queue locks. */
export async function listAdminQueue(_request: Request, response: Response): Promise<void> {
  const entries = await store.queueSnapshot();
  response.json({
    total_queued: entries.length,
    queue: entries.map((entry) => ({
      driver_id: entry.driverId,
      position: entry.position,
      joined_at: entry.joinedAt,
      status: entry.status,
      available_seats: entry.availableSeats,
    })),
  });
}

/** Return aggregate trip counts without exposing order or passenger details. */
export async function getTripStatistics(_request: Request, response: Response): Promise<void> {
  const byStatus: Record<OrderStatus, number> = {
    searching: 0,
    en_route_to_c: 0,
    arrived_at_c: 0,
    boarded_waiting: 0,
    in_transit: 0,
    completed: 0,
    cancelled: 0,
  };
  const orders = await store.listOrders();
  for (const order of orders) {
    byStatus[order.status] += 1;
  }
  response.json({
    statistics: {
      total: orders.length,
      active: orders.length - byStatus.completed - byStatus.cancelled,
      completed: byStatus.completed,
      cancelled: byStatus.cancelled,
      by_status: byStatus,
    },
  });
}

/** List accounts that have passenger capability, including users in driver mode. */
export async function listPassengers(_request: Request, response: Response): Promise<void> {
  response.json({
    passengers: (await store.listUsers("passenger")).map((user) => serializeUser(user)),
  });
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
    request.body?.expected_vehicle_revision,
  );
  if (!user) {
    throw new AppError(404, "Driver not found", "DRIVER_NOT_FOUND");
  }
  response.json({ driver: serializeUser(user) });
}
