import { randomUUID } from "node:crypto";
import type { RouteLayoutInput } from "../store/storeContract";
import type { RouteDefinition, RouteStop } from "../types/domain";
import { AppError } from "./errors";
import { boundedInteger, requiredString } from "./validation";

type StopPatch = Partial<Pick<RouteStop, "code" | "name" | "sequence" | "position">>;
type StopMutation =
  | { kind: "add"; input: { code: string; name: string; sequence?: number; position?: number } }
  | { kind: "update"; stopId: string; patch: StopPatch }
  | { kind: "delete"; stopId: string };

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError(400, `${field} must be an object`, "VALIDATION_ERROR");
  }
  return value as Record<string, unknown>;
}

function stopCode(value: unknown, field = "code"): string {
  return requiredString(requiredString(value, field, 40).toUpperCase(), field, 40);
}

function point(value: unknown): { lat: number; lng: number } {
  const location = record(value, "location");
  const { lat, lng } = location;
  if (typeof lat !== "number" || !Number.isFinite(lat) || lat < -90 || lat > 90 ||
      typeof lng !== "number" || !Number.isFinite(lng) || lng < -180 || lng > 180) {
    throw new AppError(400, "location requires numeric latitude from -90 to 90 and longitude from -180 to 180", "INVALID_COORDINATES");
  }
  return { lat, lng };
}

/** Reject coercion of empty, null, boolean, or string geometry fields. */
export function validateRouteLayoutInput(input: RouteLayoutInput): RouteLayoutInput {
  const raw = record(input, "layout");
  const expectedUpdatedAt = raw.expectedUpdatedAt;
  if (typeof expectedUpdatedAt !== "string" || !expectedUpdatedAt.trim() || expectedUpdatedAt.length > 80) {
    throw new AppError(400, "expected_updated_at is required", "VALIDATION_ERROR");
  }
  if (!Array.isArray(raw.stops) || raw.stops.length > 1000) {
    throw new AppError(400, "stops must be an array with at most 1000 items", "VALIDATION_ERROR");
  }
  const ids = new Set<string>();
  const codes = new Set<string>();
  const stops = raw.stops.map((value) => {
    const stop = record(value, "stop");
    const id = stop.id === undefined ? undefined : requiredString(stop.id, "stop.id", 80);
    const code = stopCode(stop.code);
    if ((id && ids.has(id)) || codes.has(code)) {
      throw new AppError(400, "Stop IDs and codes must be unique within the route", "INVALID_ROUTE_LAYOUT");
    }
    if (id) ids.add(id);
    codes.add(code);
    return {
      ...(id ? { id } : {}),
      code,
      name: requiredString(stop.name, "name", 120),
      ...(stop.location === undefined ? {} : { location: point(stop.location) }),
    };
  });
  let pitaks: RouteLayoutInput["pitaks"];
  if (raw.pitaks !== undefined) {
    const value = record(raw.pitaks, "pitaks");
    if (typeof value.radiusMeters !== "number" || !Number.isInteger(value.radiusMeters) ||
        value.radiusMeters < 10 || value.radiusMeters > 5000) {
      throw new AppError(400, "radius_meters must be an integer between 10 and 5000", "VALIDATION_ERROR");
    }
    pitaks = {
      aStopCode: stopCode(value.aStopCode, "a_stop_code"),
      bStopCode: stopCode(value.bStopCode, "b_stop_code"),
      radiusMeters: value.radiusMeters,
    };
    assertPitaks(stops, pitaks, false);
  }
  return { expectedUpdatedAt, stops, ...(pitaks ? { pitaks } : {}) };
}

/** Translate the HTTP snake-case body into the sole store layout contract. */
export function readRouteLayoutInput(body: unknown): RouteLayoutInput {
  const raw = record(body, "layout");
  const pitaks = raw.pitaks === undefined ? undefined : record(raw.pitaks, "pitaks");
  return validateRouteLayoutInput({
    expectedUpdatedAt: raw.expected_updated_at,
    stops: raw.stops,
    ...(pitaks ? { pitaks: {
      aStopCode: pitaks.a_stop_code,
      bStopCode: pitaks.b_stop_code,
      radiusMeters: pitaks.radius_meters,
    } } : {}),
  } as RouteLayoutInput);
}

function assertPitaks(
  stops: Array<Pick<RouteStop, "code"> & { location?: { lat: number; lng: number }; sequence?: number; position?: number }>,
  pitaks: NonNullable<RouteDefinition["pitaks"]>,
  legacyMutation: boolean,
): void {
  const a = stops.find((stop) => stop.code === pitaks.aStopCode);
  const b = stops.find((stop) => stop.code === pitaks.bStopCode);
  let valid = pitaks.aStopCode !== pitaks.bStopCode && a && b && a.location && b.location &&
    stops[0] === a && stops[stops.length - 1] === b;
  if (valid && legacyMutation) {
    // Fares use position; both independent legacy ordering fields must keep
    // the configured endpoints first and last.
    valid = stops.every((stop) =>
      (stop === a || (stop.sequence! > a!.sequence! && stop.position! > a!.position!)) &&
      (stop === b || (stop.sequence! < b!.sequence! && stop.position! < b!.position!)),
    );
  }
  if (!valid) {
    throw new AppError(
      legacyMutation ? 409 : 400,
      legacyMutation
        ? "This change affects pitaks A/B or their order; use the route layout editor"
        : "Pitaks A and B must be distinct first and last stops, each with coordinates",
      legacyMutation ? "ROUTE_LAYOUT_EDITOR_REQUIRED" : "INVALID_ROUTE_LAYOUT",
    );
  }
}

/** Each route mutation changes its version even within one millisecond. */
export function nextRouteUpdatedAt(previous: string): string {
  const previousMs = Date.parse(previous);
  return new Date(Math.max(Date.now(), Number.isFinite(previousMs) ? previousMs + 1 : 0)).toISOString();
}

/** Pure replacement applied only after locking and reading the live route. */
export function replaceRouteLayout(route: RouteDefinition, input: RouteLayoutInput): RouteDefinition {
  const layout = validateRouteLayoutInput(input);
  if (layout.expectedUpdatedAt !== route.updatedAt) {
    throw new AppError(409, "Route changed; reload it before saving the layout", "ROUTE_CHANGED");
  }
  const currentIds = new Set(route.stops.map((stop) => stop.id));
  for (const stop of layout.stops) {
    if (stop.id && !currentIds.has(stop.id)) {
      throw new AppError(400, "Provided stop IDs must belong to this route", "INVALID_ROUTE_LAYOUT");
    }
  }
  const timestamp = Date.now();
  const stops = layout.stops.map((stop, index): RouteStop => ({
    id: stop.id ?? randomUUID(),
    code: stop.code,
    name: stop.name,
    sequence: index + 1,
    position: index + 1,
    ...(stop.location ? { location: { ...stop.location, timestamp } } : {}),
  }));
  const { pitaks: _oldPitaks, ...metadata } = route;
  return {
    ...metadata,
    stops,
    ...(layout.pitaks ? { pitaks: layout.pitaks } : {}),
    updatedAt: nextRouteUpdatedAt(route.updatedAt),
  };
}

/** Existing stop endpoints share this pure mutation, preserving static layout. */
export function mutateRouteStop(route: RouteDefinition, mutation: StopMutation): { route: RouteDefinition; stop?: RouteStop } | undefined {
  const stops = route.stops.map((stop) => ({ ...stop }));
  let stop: RouteStop | undefined;
  if (mutation.kind === "add") {
    const sequence = mutation.input.sequence === undefined
      ? stops.length + 1 : boundedInteger(mutation.input.sequence, "sequence", 1, 100_000);
    stop = {
      id: randomUUID(),
      code: stopCode(mutation.input.code),
      name: requiredString(mutation.input.name, "name", 120),
      sequence,
      position: mutation.input.position === undefined
        ? sequence : boundedInteger(mutation.input.position, "position", 1, 100_000),
    };
    stops.push(stop);
  } else {
    const index = stops.findIndex((candidate) => candidate.id === mutation.stopId);
    if (index < 0) return undefined;
    const current = stops[index]!;
    const isPitak = route.pitaks && [route.pitaks.aStopCode, route.pitaks.bStopCode].includes(current.code);
    if (isPitak && (mutation.kind === "delete" ||
        (mutation.patch.code !== undefined && stopCode(mutation.patch.code) !== current.code))) {
      throw new AppError(409, "To remove or change a pitak stop code, use the route layout editor", "ROUTE_LAYOUT_EDITOR_REQUIRED");
    }
    if (mutation.kind === "delete") {
      stops.splice(index, 1);
    } else {
      const patch = mutation.patch;
      stop = {
        ...current,
        ...(patch.code === undefined ? {} : { code: stopCode(patch.code) }),
        ...(patch.name === undefined ? {} : { name: requiredString(patch.name, "name", 120) }),
        ...(patch.sequence === undefined ? {} : { sequence: boundedInteger(patch.sequence, "sequence", 1, 100_000) }),
        ...(patch.position === undefined ? {} : { position: boundedInteger(patch.position, "position", 1, 100_000) }),
      };
      stops[index] = stop;
    }
  }
  if (new Set(stops.map((candidate) => candidate.code)).size !== stops.length) {
    throw new AppError(400, "Stop codes must be unique within the route", "INVALID_ROUTE_LAYOUT");
  }
  stops.sort((a, b) => a.sequence - b.sequence);
  if (route.pitaks) assertPitaks(stops, route.pitaks, true);
  return { route: { ...route, stops, updatedAt: nextRouteUpdatedAt(route.updatedAt) }, ...(stop ? { stop } : {}) };
}
