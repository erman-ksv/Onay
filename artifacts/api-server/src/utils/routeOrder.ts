import type { Coordinates, Order, RouteDefinition } from "../types/domain";
import type { DriverRouteChoiceInput } from "../store/storeContract";
import { assertDriverRouteChoiceRoute, isDriverRouteConfigured, validateDriverRouteChoiceInput } from "./driverRoute";
import { resolveRouteQueue } from "./routeQueue";
import { isValidCoordinates, isWithinRadius } from "./geo";
import { AppError } from "./errors";

function validRouteOrderPricing(route: RouteDefinition): boolean {
  if (route.currency !== "KZT" || !Number.isSafeInteger(route.pricePerStopKzt) || route.pricePerStopKzt < 0) return false;
  const first = route.stops[0];
  const last = route.stops[route.stops.length - 1];
  return Boolean(first && last && Number.isSafeInteger(first.position) && Number.isSafeInteger(last.position) &&
    Number.isSafeInteger(Math.max(1, Math.ceil(Math.abs(last.position - first.position))) * route.pricePerStopKzt));
}

/** Call under the live route lock when persisting a configured order. */
export function buildRouteOrder(
  route: RouteDefinition | undefined,
  selection: DriverRouteChoiceInput,
  pickupLocation?: Coordinates,
): Pick<Order, "pickupPoint" | "routeContext" | "routeStops" | "fare" | "destination"> {
  const input = validateDriverRouteChoiceInput(selection);
  assertDriverRouteChoiceRoute(route, input.expectedUpdatedAt);
  if (route.id !== input.routeId) throw new AppError(409, "Route changed; reload the catalog", "ROUTE_CHANGED");
  if (!validRouteOrderPricing(route)) {
    throw new AppError(422, "Route pricing is invalid", "ROUTE_NOT_CONFIGURED");
  }
  const routeContext = resolveRouteQueue({
    routeId: input.routeId, direction: input.direction, routeUpdatedAt: input.expectedUpdatedAt,
  }, route, input)!;
  if (pickupLocation && (!isValidCoordinates(pickupLocation) || pickupLocation.isMocked === true ||
      !isWithinRadius(pickupLocation, routeContext.center, routeContext.radiusMeters))) {
    throw new AppError(422, "Passenger must be at the selected pickup pitak", "OUTSIDE_PICKUP_GEOFENCE");
  }
  const stops = structuredClone(input.direction === "a_to_b" ? route.stops : [...route.stops].reverse());
  const pickupStop = stops[0]!;
  const destinationStop = stops[stops.length - 1]!;
  const distanceStops = Math.max(1, Math.ceil(Math.abs(destinationStop.position - pickupStop.position)));
  return {
    pickupPoint: routeContext.pitak,
    routeContext,
    routeStops: stops,
    destination: destinationStop.name,
    fare: {
      currency: route.currency, routeId: route.id, pickupStop, destinationStop,
      pickupPosition: pickupStop.position, destinationPosition: destinationStop.position,
      distanceStops, pricePerStopKzt: route.pricePerStopKzt, minimumFareApplied: false,
      stops, totalKzt: distanceStops * route.pricePerStopKzt, calculatedAt: new Date().toISOString(),
    },
  };
}

/** A catalog edit invalidates only unaccepted offers, not trips already underway. */
export function routeOrderIsCurrent(order: Pick<Order, "routeContext">, route?: RouteDefinition): boolean {
  const context = order.routeContext;
  return !context || Boolean(route && route.active === true && isDriverRouteConfigured(route) &&
    validRouteOrderPricing(route) && route.id === context.routeId && route.updatedAt === context.routeUpdatedAt);
}
