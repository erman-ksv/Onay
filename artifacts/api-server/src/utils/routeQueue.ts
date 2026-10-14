import type { Coordinates, DriverRouteChoice, QueueEntry, RouteDefinition, RouteQueueContext } from "../types/domain";
import type { DriverRouteChoiceInput } from "../store/storeContract";
import { assertDriverRouteChoiceRoute, validateDriverRouteChoiceInput } from "./driverRoute";
import { AppError } from "./errors";
import { isValidCoordinates, isWithinRadius } from "./geo";

/** A request proves the UI's saved choice; all queue geometry comes from the server. */
export function resolveRouteQueue(
  choice: DriverRouteChoice | undefined,
  route: RouteDefinition | undefined,
  selection: DriverRouteChoiceInput | undefined,
  location?: Coordinates,
): RouteQueueContext | undefined {
  if (!choice) {
    if (selection) throw new AppError(409, "Saved route choice changed; reload it", "ROUTE_CHANGED");
    return undefined;
  }
  if (!selection) throw new AppError(409, "Reload the saved route before joining its queue", "ROUTE_QUEUE_NOT_AVAILABLE");
  const input = validateDriverRouteChoiceInput(selection);
  if (input.routeId !== choice.routeId || input.direction !== choice.direction || input.expectedUpdatedAt !== choice.routeUpdatedAt) {
    throw new AppError(409, "Saved route choice changed; reload it", "ROUTE_CHANGED");
  }
  assertDriverRouteChoiceRoute(route, choice.routeUpdatedAt);
  const pitak = choice.direction === "a_to_b" ? "A" : "B";
  const stop = pitak === "A" ? route.stops[0]! : route.stops[route.stops.length - 1]!;
  const context: RouteQueueContext = {
    routeId: route.id, routeName: route.name, direction: choice.direction,
    routeUpdatedAt: route.updatedAt, pitak, stopCode: stop.code, stopName: stop.name,
    center: { ...stop.location!, timestamp: 0 }, radiusMeters: route.pitaks!.radiusMeters,
  };
  if (location) assertRouteQueueLocation(context, location);
  return context;
}

export function assertRouteQueueLocation(context: RouteQueueContext, location: Coordinates): void {
  if (!isValidCoordinates(location) || location.isMocked === true) {
    throw new AppError(422, "Valid location is required", "INVALID_COORDINATES");
  }
  if (!isWithinRadius(location, context.center, context.radiusMeters)) {
    throw new AppError(422, `Driver must be at pitak ${context.pitak}`, "OUTSIDE_QUEUE_GEOFENCE");
  }
}

export function sameQueueLane(a: RouteQueueContext | undefined, b: RouteQueueContext | undefined): boolean {
  return a === undefined || b === undefined ? a === b : a.routeId === b.routeId && a.pitak === b.pitak && a.direction === b.direction;
}

export function routeQueueSnapshot(entries: QueueEntry[]): Array<QueueEntry & { position: number }> {
  const counts = new Map<string, number>();
  return entries.map(entry => {
    const key = entry.routeContext ? JSON.stringify([entry.routeContext.routeId, entry.routeContext.direction, entry.routeContext.pitak]) : "legacy";
    const position = (counts.get(key) ?? 0) + 1;
    counts.set(key, position);
    return { ...entry, position };
  });
}
