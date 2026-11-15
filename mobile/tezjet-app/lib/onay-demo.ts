import type { FareMoney } from "./fare-money";
import type { RideOrder, RideStatus } from "./orders";

export type DemoRole = "passenger" | "driver";
export type DemoRide = RideOrder & { fare: FareMoney & NonNullable<RideOrder["fare"]> };
export type DemoState = { role: DemoRole; ride: DemoRide | null; history: DemoRide[]; online: boolean };
export type DemoAction = { type: "role"; role: DemoRole } | { type: "online" } |
  { type: "start"; seats: number; reverse?: boolean } | { type: "advance"; expectedStatus: RideStatus } |
  { type: "cancel"; expectedStatus: RideStatus };

/** Explicit preview-build flag. It never changes authentication or API admission. */
export function onayDemoPreviewEnabled(extra: unknown): boolean {
  return !!extra && typeof extra === "object" && (extra as Record<string, unknown>).onayDemoPreview === true;
}

export function createDemoRide(seats: number, status: RideStatus = "searching", reverse = false, offered = false): DemoRide {
  if (!Number.isSafeInteger(seats) || seats < 1 || seats > 8) throw new Error("Демо: выберите от 1 до 8 мест");
  const start = reverse ? "ДЕМО · Gazalkent" : "ДЕМО · Shaxsham", end = reverse ? "ДЕМО · Shaxsham" : "ДЕМО · Gazalkent";
  return { id: "onay-demo-ride", passenger_id: "onay-demo-passenger", status,
    ...(status === "searching" ? (offered ? { offered_driver_id: "onay-demo-driver" } : {}) : { driver_id: "onay-demo-driver" }),
    pickup_point: start, destination: end, seats,
    created_at: "2026-11-07T00:00:00.000Z", updated_at: "2026-11-07T00:00:00.000Z",
    fare: { total: seats * 12000, currency: "UZS", pickupStop: { name: start }, destinationStop: { name: end } } };
}

export function createDemoState(role: DemoRole): DemoState {
  return { role, ride: null, online: false, history: [{ ...createDemoRide(2, "completed"), id: "onay-demo-history" }] };
}
const next: Partial<Record<RideStatus, RideStatus>> = { searching: "en_route_to_c", en_route_to_c: "arrived_at_c", arrived_at_c: "boarded_waiting", boarded_waiting: "in_transit", in_transit: "completed" };

/** An offline demo driver must never see an incoming offer, even if the passenger has a pending example. */
export function canDemoDriverSeeOffer(state: DemoState): boolean {
  return state.online && !!state.ride &&
    (state.ride.status !== "searching" || state.ride.offered_driver_id === "onay-demo-driver");
}

/** All preview state is in memory. No credentials, storage, requests or sockets. */
export function onayDemoReducer(state: DemoState, action: DemoAction): DemoState {
  if (action.type === "role") return { ...state, role: action.role };
  if (action.type === "online") {
    // A driver already serving a passenger cannot go offline until the trip ends.
    if (state.online && state.ride && state.ride.status !== "searching") return state;
    const online = !state.online;
    const ride = state.ride?.status === "searching"
      ? { ...state.ride, offered_driver_id: online ? "onay-demo-driver" : undefined }
      : state.ride;
    return { ...state, online, ride };
  }
  if (action.type === "start") return state.ride ? state :
    { ...state, ride: createDemoRide(action.seats, "searching", action.reverse, state.online) };
  const current = state.ride;
  if (!current || current.status !== action.expectedStatus) return state;
  // UI hiding is not enough: reject an offline driver's attempted acceptance in the reducer too.
  if (action.type === "advance" && !canDemoDriverSeeOffer(state)) return state;
  const status = action.type === "cancel" ? "cancelled" : next[current.status];
  if (!status) return state;
  const ride = { ...current, status, ...(status !== "searching" ? { driver_id: "onay-demo-driver" } : {}) };
  if (status === "completed" || status === "cancelled") return { ...state, ride: null, history: [ride, ...state.history.filter(row => row.id !== ride.id)] };
  return { ...state, ride };
}
