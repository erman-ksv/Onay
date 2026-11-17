import { store } from "../store";
import type { QueueEntry, User } from "../types/domain";
import { PYATAK_ZONE, REQUIRE_DRIVER_APPROVAL } from "../utils/config";
import { AppError } from "../utils/errors";
import { resolveRouteQueue, sameQueueLane } from "../utils/routeQueue";
import { hasRequiredDriverApproval } from "../utils/driverVehicle";
import { verifyAccessToken } from "../utils/token";

type QueueSnapshot = Array<QueueEntry & { position: number }>;
type QueueViewOptions = { snapshot?: QueueSnapshot; requireApprovedDriver?: boolean };

/** Generic queue rows contain public lane information, never telemetry or locks. */
function publicQueueEntry(entry: QueueSnapshot[number]) {
  return { driverId: entry.driverId, position: entry.position,
    availableSeats: entry.availableSeats, status: entry.status };
}

function routeChoiceIdentity(choice: User["driverRouteChoice"]): string | null {
  return choice ? JSON.stringify([choice.routeId, choice.direction, choice.routeUpdatedAt]) : null;
}

function unauthorized(): never {
  throw new AppError(401, "Session is no longer valid", "UNAUTHORIZED");
}

/** HTTP, initial socket snapshots and events expose the same authorized lane. */
export async function queueStatusView(user: User | undefined, options: QueueViewOptions = {}) {
  if (!user) unauthorized();
  // Capture scalars before awaiting: MemoryStore may return a mutable account.
  const userId = user.id, role = user.role, sessionVersion = user.sessionVersion;
  const choice = role === "driver" && user.driverRouteChoice ? { ...user.driverRouteChoice } : undefined;
  const choiceIdentity = routeChoiceIdentity(choice);
  const entry = await store.getQueueEntry(userId);
  let context = role === "driver" ? entry?.routeContext : undefined;
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
  const snapshot = options.snapshot ?? await store.queueSnapshot();
  const position = options.snapshot
    ? snapshot.find(item => item.driverId === userId)?.position ?? null
    : await store.getQueuePosition(userId);
  const zone = context ? {
    id: `route:${context.routeId}:${context.pitak}`, name: `${context.routeName} · питак ${context.pitak}: ${context.stopName}`,
    center: context.center, geofence_meters: context.radiusMeters,
  } : routeError ? null : {
    id: PYATAK_ZONE.id, name: PYATAK_ZONE.name, center: PYATAK_ZONE.center, geofence_meters: PYATAK_ZONE.radiusMeters,
  };
  // Revocation/logout/role switching while durable reads wait must not publish
  // the earlier account's private enrollment or administrator lane authority.
  const current = await store.getUser(userId);
  if (!current || current.role !== role || current.sessionVersion !== sessionVersion) unauthorized();
  if (options.requireApprovedDriver && role === "driver" &&
      !hasRequiredDriverApproval(current, REQUIRE_DRIVER_APPROVAL)) unauthorized();
  if (role === "driver" && routeChoiceIdentity(current.driverRouteChoice) !== choiceIdentity) {
    throw new AppError(409, "Saved route choice changed; reload the queue", "ROUTE_CHANGED");
  }
  return {
    zone, queue_point: zone?.center ?? null, geofence_meters: zone?.geofence_meters ?? null,
    route_queue: context ?? null, route_queue_error: routeError,
    your_entry: role === "driver" && entry?.driverId === userId ? entry : null,
    queue: (role === "admin" ? snapshot : routeError ? [] : snapshot.filter(item => sameQueueLane(item.routeContext, context))).map(publicQueueEntry),
    your_position: role === "driver" ? position : null,
  };
}

/** Rooms are delivery addresses, not lasting role/session authorization. */
export async function queueSocketStatusView(data: Record<string, unknown>, snapshot?: QueueSnapshot) {
  const token = typeof data.accessToken === "string" ? data.accessToken : "";
  const claims = verifyAccessToken(token);
  if (!claims || claims.sub !== data.userId || claims.role !== data.role ||
      claims.sessionVersion !== data.sessionVersion) unauthorized();
  const user = await store.getUser(claims.sub);
  if (!user || user.role !== claims.role || user.sessionVersion !== claims.sessionVersion) unauthorized();
  const view = await queueStatusView(user, { snapshot, requireApprovedDriver: true });
  // A slow query must not extend the JWT's lifetime either.
  if (!verifyAccessToken(token)) unauthorized();
  return view;
}
