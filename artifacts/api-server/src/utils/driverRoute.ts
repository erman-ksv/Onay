import type { DriverRouteChoiceInput } from "../store/storeContract";
import type { DriverRouteChoice, DriverRouteOption, DriverRouteSelection, RouteDefinition, RouteStop } from "../types/domain";
import { AppError } from "./errors";
import { pickEnum, requiredString } from "./validation";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError(400, "Route choice must be an object", "VALIDATION_ERROR");
  }
  return value as Record<string, unknown>;
}

/** Validate callers of both the HTTP endpoint and the store contract. */
export function validateDriverRouteChoiceInput(input: DriverRouteChoiceInput): DriverRouteChoiceInput {
  const raw = record(input);
  return {
    routeId: requiredString(raw.routeId, "route_id", 80),
    direction: pickEnum(raw.direction, "direction", ["a_to_b", "b_to_a"] as const),
    expectedUpdatedAt: requiredString(raw.expectedUpdatedAt, "expected_updated_at", 80),
  };
}

export function readDriverRouteChoiceInput(body: unknown): DriverRouteChoiceInput {
  const raw = record(body);
  if (Object.keys(raw).some(key => !["route_id", "direction", "expected_updated_at"].includes(key))) {
    throw new AppError(400, "Route choice contains an unsupported field", "VALIDATION_ERROR");
  }
  return validateDriverRouteChoiceInput({
    routeId: raw.route_id,
    direction: raw.direction,
    expectedUpdatedAt: raw.expected_updated_at,
  } as DriverRouteChoiceInput);
}

function hasCoordinates(stop: RouteStop): boolean {
  const point = stop.location;
  return Boolean(point && typeof point.lat === "number" && Number.isFinite(point.lat) &&
    point.lat >= -90 && point.lat <= 90 &&
    typeof point.lng === "number" && Number.isFinite(point.lng) && point.lng >= -180 && point.lng <= 180);
}

/** Treat draft or malformed historical configurations as unavailable. */
export function isDriverRouteConfigured(route: RouteDefinition): boolean {
  if (!route || typeof route !== "object" || Array.isArray(route) ||
      typeof route.id !== "string" || !route.id.trim() ||
      typeof route.name !== "string" || !route.name.trim() ||
      typeof route.updatedAt !== "string" || !route.updatedAt.trim()) return false;
  const { stops, pitaks } = route;
  if (!Array.isArray(stops) || stops.length < 2 || stops.length > 1000 || !pitaks ||
      typeof pitaks !== "object" || Array.isArray(pitaks) ||
      typeof pitaks.aStopCode !== "string" || typeof pitaks.bStopCode !== "string" ||
      pitaks.aStopCode === pitaks.bStopCode ||
      !Number.isInteger(pitaks.radiusMeters) || pitaks.radiusMeters < 10 || pitaks.radiusMeters > 5000) return false;
  const codes = new Set<string>();
  const ids = new Set<string>();
  for (let index = 0; index < stops.length; index += 1) {
    const stop = stops[index];
    if (!stop || typeof stop !== "object" || Array.isArray(stop) ||
        typeof stop.id !== "string" || !stop.id.trim() || ids.has(stop.id) ||
        typeof stop.code !== "string" || !stop.code.trim() || codes.has(stop.code) ||
        typeof stop.name !== "string" || !stop.name.trim() ||
        !Number.isInteger(stop.sequence) || stop.sequence < 1 ||
        !Number.isInteger(stop.position) || stop.position < 1 ||
        (stop.location !== undefined && !hasCoordinates(stop))) return false;
    const previous = stops[index - 1];
    if (previous && (stop.sequence <= previous.sequence || stop.position <= previous.position)) return false;
    codes.add(stop.code);
    ids.add(stop.id);
  }
  const first = stops[0]!;
  const last = stops[stops.length - 1]!;
  return first.code === pitaks.aStopCode && last.code === pitaks.bStopCode &&
    hasCoordinates(first) && hasCoordinates(last);
}

export function driverRouteOption(route: RouteDefinition): DriverRouteOption | null {
  if (!isDriverRouteConfigured(route)) return null;
  return structuredClone({
    id: route.id,
    name: route.name,
    updatedAt: route.updatedAt,
    stops: route.stops,
    pitaks: route.pitaks!,
  });
}

export function assertDriverRouteChoiceRoute(route: RouteDefinition | undefined, expectedUpdatedAt: string): asserts route is RouteDefinition {
  if (!route) throw new AppError(404, "Route was not found", "ROUTE_NOT_FOUND");
  if (route.updatedAt !== expectedUpdatedAt) {
    throw new AppError(409, "Route changed; reload the catalog before choosing it", "ROUTE_CHANGED");
  }
  if (route.active !== true) throw new AppError(422, "Route is inactive", "ROUTE_INACTIVE");
  if (!isDriverRouteConfigured(route)) {
    throw new AppError(422, "Route requires valid configured pitaks A and B", "ROUTE_NOT_CONFIGURED");
  }
}

/** Keep invalid saved choices explicit; never silently substitute another route. */
export function driverRouteSelection(choice: DriverRouteChoice | undefined | null, route?: RouteDefinition): DriverRouteSelection {
  if (!choice) return { choice: null, route: null, unavailable_reason: null };
  const saved = structuredClone(choice);
  if (!route) return { choice: saved, route: null, unavailable_reason: "ROUTE_MISSING" };
  if (route.active !== true) return { choice: saved, route: null, unavailable_reason: "ROUTE_INACTIVE" };
  const option = driverRouteOption(route);
  if (!option) return { choice: saved, route: null, unavailable_reason: "ROUTE_NOT_CONFIGURED" };
  if (route.updatedAt !== choice.routeUpdatedAt) return { choice: saved, route: null, unavailable_reason: "ROUTE_CHANGED" };
  return { choice: saved, route: option, unavailable_reason: null };
}
