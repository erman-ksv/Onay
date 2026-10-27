export type RideStatus = "searching" | "en_route_to_c" | "arrived_at_c" | "boarded_waiting" | "in_transit" | "completed" | "cancelled";
export type RideOrder = {
  id: string;
  status: RideStatus;
  pickup_point: string;
  destination?: string;
  pickup_address?: string;
  fare?: { pickupStop?: { name?: string }; destinationStop?: { name?: string } };
  seats: number;
  passenger_id?: string;
  driver_id?: string;
  offered_driver_id?: string;
  offer_expires_at?: number;
  seat_lock_expires_at?: number;
  created_at?: string;
  updated_at?: string;
};

function stopLabel(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** pickup_point identifies the dispatch lane; it can differ from the booked stop. */
export function ridePickupLabel(order: RideOrder): string {
  return stopLabel(order.pickup_address) ?? stopLabel(order.fare?.pickupStop?.name) ??
    stopLabel(order.pickup_point) ?? "Место посадки";
}

export function rideDestinationLabel(order: RideOrder): string {
  return stopLabel(order.destination) ?? stopLabel(order.fare?.destinationStop?.name) ?? "По маршруту";
}

export function isClosed(order: RideOrder): boolean {
  return order.status === "completed" || order.status === "cancelled";
}

export function isLiveOffer(order: RideOrder, driverId: string, now = Date.now()): boolean {
  return order.status === "searching" && !order.driver_id && order.offered_driver_id === driverId &&
    order.offer_expires_at !== undefined && order.offer_expires_at > now;
}

export function mergeOrder(orders: RideOrder[], incoming: RideOrder): RideOrder[] {
  const existing = orders.find(order => order.id === incoming.id);
  if (existing?.updated_at && incoming.updated_at && existing.updated_at > incoming.updated_at) return orders;
  return [incoming, ...orders.filter(order => order.id !== incoming.id)]
    .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
}

/** Reconcile a full GET response without overwriting events received while it was in flight. */
export function mergeOrderSnapshot(orders: RideOrder[], snapshot: RideOrder[], changedAfterRequest: ReadonlySet<string> = new Set()): RideOrder[] {
  const visibleIds = new Set(snapshot.map(order => order.id));
  let merged = orders.filter(order => visibleIds.has(order.id) || changedAfterRequest.has(order.id));
  for (const incoming of snapshot) {
    if (!changedAfterRequest.has(incoming.id)) merged = mergeOrder(merged, incoming);
  }
  return merged;
}

export const statusLabels: Record<RideStatus, string> = {
  searching: "Ищем водителя",
  en_route_to_c: "Водитель едет к точке подачи",
  arrived_at_c: "Водитель прибыл",
  boarded_waiting: "Ты в машине. Ожидаем отправления водителя",
  in_transit: "Поездка началась",
  completed: "Поездка завершена",
  cancelled: "Заказ отменён",
};

/** For line collection, boarding is recorded separately by /orders/:id/board;
 * departure is a queue-level action. Never advance boarded_waiting using
 * the legacy per-order status button. */
export function nextTripStatus(order: RideOrder): RideStatus | null {
  return order.status === "en_route_to_c" ? "arrived_at_c"
    : order.status === "arrived_at_c" ? "in_transit"
    : order.status === "in_transit" ? "completed" : null;
}

/** Suppress the legacy start-trip action while a line is collecting passengers.
 * The server's /queue/depart owns the collecting-line departure. */
export function nextDriverTripStatus(linePhase: "collecting" | "departed" | null, order: RideOrder): RideStatus | null {
  const next = nextTripStatus(order);
  return linePhase === "collecting" && next === "in_transit" ? null : next;
}

export function nextTripLabel(order: RideOrder): string {
  const next = nextTripStatus(order);
  return next === "arrived_at_c" ? "Я прибыл на точку"
    : next === "in_transit" ? "Начать поездку"
    : next === "completed" ? "Завершить поездку" : "";
}
