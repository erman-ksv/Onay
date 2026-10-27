import type { Coordinates, Order, RouteDefinition } from "../types/domain";
import type { RouteOrderSelectionInput } from "../store/storeContract";
import { assertDriverRouteChoiceRoute, isDriverRouteConfigured, validateDriverRouteChoiceInput } from "./driverRoute";
import { resolveRouteQueue } from "./routeQueue";
import { isValidCoordinates, isWithinRadius } from "./geo";
import { AppError } from "./errors";
import { optionalString } from "./validation";
import { fareMoneyFields } from "./fareMoney";
import { routePricePerStop } from "./routePricing";

/** Passenger stop selectors must survive every HTTP/store normalization step. */
export function validateRouteOrderSelectionInput(selection: RouteOrderSelectionInput): RouteOrderSelectionInput {
  const choice = validateDriverRouteChoiceInput(selection);
  const pickupStopId = optionalString(selection.pickupStopId, "pickup_stop_id", 80);
  const destinationStopId = optionalString(selection.destinationStopId, "destination_stop_id", 80);
  return {
    ...choice,
    ...(pickupStopId === undefined ? {} : { pickupStopId }),
    ...(destinationStopId === undefined ? {} : { destinationStopId }),
  };
}

function validRouteOrderPricing(route: RouteDefinition): boolean {
  let price: number;
  try { price = routePricePerStop(route); } catch { return false; }
  const first = route.stops[0];
  const last = route.stops[route.stops.length - 1];
  return Boolean(first && last && Number.isSafeInteger(first.position) && Number.isSafeInteger(last.position) &&
    Number.isSafeInteger(Math.max(1, Math.ceil(Math.abs(last.position - first.position))) * price));
}

/** Call under the live route lock when persisting a configured order. */
export function buildRouteOrder(
  route: RouteDefinition | undefined,
  selection: RouteOrderSelectionInput,
  pickupLocation?: Coordinates,
): Pick<Order, "pickupPoint" | "routeContext" | "routeStops" | "fare" | "destination"> {
  const input = validateRouteOrderSelectionInput(selection);
  assertDriverRouteChoiceRoute(route, input.expectedUpdatedAt);
  if (route.id !== input.routeId) throw new AppError(409, "Route changed; reload the catalog", "ROUTE_CHANGED");
  if (!validRouteOrderPricing(route)) {
    throw new AppError(422, "Route pricing is invalid", "ROUTE_NOT_CONFIGURED");
  }
  const routeContext = resolveRouteQueue({
    routeId: input.routeId, direction: input.direction, routeUpdatedAt: input.expectedUpdatedAt,
  }, route, input)!;
  const orderedStops = input.direction === "a_to_b" ? route.stops : [...route.stops].reverse();
  const pickupIndex = input.pickupStopId === undefined ? 0 : orderedStops.findIndex(stop => stop.id === input.pickupStopId);
  const destinationIndex = input.destinationStopId === undefined ? orderedStops.length - 1 : orderedStops.findIndex(stop => stop.id === input.destinationStopId);
  if (pickupIndex < 0 || destinationIndex < 0) {
    throw new AppError(404, "Selected stop was not found in this route", "ROUTE_STOP_NOT_FOUND");
  }
  if (pickupIndex >= destinationIndex) {
    throw new AppError(422, "Pickup must precede destination in the selected direction", "INVALID_ROUTE_SEGMENT");
  }
  const stops = structuredClone(orderedStops.slice(pickupIndex, destinationIndex + 1));
  const pickupStop = stops[0]!;
  const destinationStop = stops[stops.length - 1]!;
  if (!pickupStop.location || !isValidCoordinates(pickupStop.location) ||
      !destinationStop.location || !isValidCoordinates(destinationStop.location)) {
    throw new AppError(422, "Selected stops require administrator-configured coordinates", "ROUTE_STOP_NOT_CONFIGURED");
  }
  if (pickupLocation && (!isValidCoordinates(pickupLocation) || pickupLocation.isMocked === true ||
      !isWithinRadius(pickupLocation, pickupStop.location, routeContext.radiusMeters))) {
    throw new AppError(422, "Passenger must be at the selected pickup stop", "OUTSIDE_PICKUP_GEOFENCE");
  }
  const distanceStops = Math.max(1, Math.ceil(Math.abs(destinationStop.position - pickupStop.position)));
  return {
    // Dispatch stays in the origin pitak's lane; the fare owns the actual stops.
    pickupPoint: routeContext.pitak,
    routeContext,
    routeStops: stops,
    destination: destinationStop.name,
    fare: {
      ...fareMoneyFields(route, distanceStops * routePricePerStop(route)),
      routeId: route.id, pickupStop, destinationStop,
      pickupPosition: pickupStop.position, destinationPosition: destinationStop.position,
      distanceStops, minimumFareApplied: false,
      stops, calculatedAt: new Date().toISOString(),
    },
  };
}

/** A catalog edit invalidates only unaccepted offers, not trips already underway. */
export function routeOrderIsCurrent(order: Pick<Order, "routeContext">, route?: RouteDefinition): boolean {
  const context = order.routeContext;
  return !context || Boolean(route && route.active === true && isDriverRouteConfigured(route) &&
    validRouteOrderPricing(route) && route.id === context.routeId && route.updatedAt === context.routeUpdatedAt);
}
