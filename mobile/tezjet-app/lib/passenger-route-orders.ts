import { ApiError } from "./api.ts";
import { orderedDriverStops, parseDriverRoute, type DriverDirection, type DriverRouteOption } from "./driver-routes.ts";
export type PassengerRoute = DriverRouteOption & { currency: "KZT"; pricePerStopKzt: number };
export type PassengerRouteAvailability = { available: boolean; eligible_driver_count: number; offer_timeout_seconds: number; fare: { currency: "KZT"; totalKzt: number } };
function invalid(): never { throw new ApiError("Некорректные данные маршрута. Повтори обновление.", undefined, "INVALID_RESPONSE"); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function int(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}
export function parsePassengerRouteCatalog(value: unknown): PassengerRoute[] {
  const raw = record(value);
  if (!Array.isArray(raw.routes)) return invalid();
  const routes = raw.routes.map(item => {
    const fields = record(item), route = parseDriverRoute(item);
    if (fields.currency !== "KZT" || !int(fields.pricePerStopKzt, 0)) return invalid();
    return { ...route, currency: "KZT" as const, pricePerStopKzt: fields.pricePerStopKzt };
  });
  if (new Set(routes.map(route => route.id)).size !== routes.length) return invalid();
  return routes;
}
export function passengerRouteEndpoints(route: PassengerRoute, direction: DriverDirection) {
  const stops = orderedDriverStops(route, direction);
  if (stops.length < 2) return invalid();
  return { from: stops[0], to: stops[stops.length - 1] };
}
function choice(route: PassengerRoute, direction: DriverDirection, seats: number) {
  if (!route || !route.id || !route.updatedAt || !["a_to_b", "b_to_a"].includes(direction) || !int(seats, 1, 8)) {
    throw new ApiError("Выбери маршрут и от 1 до 8 мест.", undefined, "VALIDATION_ERROR");
  }
  return { route_id: route.id, direction, expected_updated_at: route.updatedAt };
}
export function passengerRouteKey(route: PassengerRoute, direction: DriverDirection, seats: number) {
  const c = choice(route, direction, seats);
  return JSON.stringify([c.route_id, c.expected_updated_at, c.direction, seats]);
}
export function passengerRouteAvailabilityPath(route: PassengerRoute, direction: DriverDirection, seats: number) {
  const c = choice(route, direction, seats);
  return "/api/orders/route/availability?" + Object.entries({ ...c, seats })
    .map(([k,v])=>encodeURIComponent(k)+"="+encodeURIComponent(String(v))).join("&");
}
export function parsePassengerRouteAvailability(value: unknown): PassengerRouteAvailability {
  const body = record(value), fare = record(body.fare);
  if (typeof body.available !== "boolean" || !int(body.eligible_driver_count, 0) ||
      !int(body.offer_timeout_seconds, 1, 86400) || fare.currency !== "KZT" ||
      !int(fare.totalKzt, 0) || (body.available && body.eligible_driver_count === 0)) return invalid();
  return { available: body.available, eligible_driver_count: body.eligible_driver_count,
    offer_timeout_seconds: body.offer_timeout_seconds, fare: { currency: "KZT", totalKzt: fare.totalKzt } };
}
export function passengerRouteOrderPayload(route: PassengerRoute, direction: DriverDirection, seats: number,
  location: { lat: number; lng: number; timestamp: number; isMocked: boolean }) {
  const c = choice(route, direction, seats);
  if (!location || !Number.isFinite(location.lat) || !Number.isFinite(location.lng) ||
      Math.abs(location.lat)>90 || Math.abs(location.lng)>180 ||
      !Number.isFinite(location.timestamp) || location.timestamp<=0 || location.isMocked === true) {
    throw new ApiError("Нужна настоящая геолокация у выбранного питака.", undefined, "INVALID_COORDINATES");
  }
  return { ...c, seats, pickup_location: { lat: location.lat, lng: location.lng, timestamp: location.timestamp, isMocked: false } };
}
