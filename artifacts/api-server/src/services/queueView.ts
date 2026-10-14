import { store } from "../store";
import type { User } from "../types/domain";
import { PYATAK_ZONE } from "../utils/config";
import { AppError } from "../utils/errors";
import { resolveRouteQueue, sameQueueLane } from "../utils/routeQueue";

/** HTTP and initial socket snapshots expose the same authorized lane. */
export async function queueStatusView(user: User | undefined) {
  const entry = user ? await store.getQueueEntry(user.id) : undefined;
  const choice = user?.role === "driver" ? user.driverRouteChoice : undefined;
  let context = entry?.routeContext;
  let routeError: string | null = null;
  if (!context && choice) {
    try {
      context = resolveRouteQueue(choice, await store.getRoute(choice.routeId), {
        routeId: choice.routeId, direction: choice.direction, expectedUpdatedAt: choice.routeUpdatedAt,
      });
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      routeError = error.code;
    }
  }
  const snapshot = await store.queueSnapshot();
  const zone = context ? {
    id: `route:${context.routeId}:${context.pitak}`, name: `${context.routeName} · питак ${context.pitak}: ${context.stopName}`,
    center: context.center, geofence_meters: context.radiusMeters,
  } : routeError ? null : {
    id: PYATAK_ZONE.id, name: PYATAK_ZONE.name, center: PYATAK_ZONE.center, geofence_meters: PYATAK_ZONE.radiusMeters,
  };
  return {
    zone, queue_point: zone?.center ?? null, geofence_meters: zone?.geofence_meters ?? null,
    route_queue: context ?? null, route_queue_error: routeError, your_entry: entry ?? null,
    queue: user?.role === "admin" ? snapshot : routeError ? [] : snapshot.filter(item => sameQueueLane(item.routeContext, context)),
    your_position: user ? await store.getQueuePosition(user.id) : null,
  };
}
