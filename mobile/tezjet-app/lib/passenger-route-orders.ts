import type { DriverDirection, DriverRouteOption } from "./driver-routes";

/**
 * Keep route-catalog fetches independent from short-lived availability quotes.
 * A selection change must not cancel the initial catalog load; a stale quote
 * must never be allowed to repopulate availability after its selection changes.
 */
export function createPassengerRouteRequestScope() {
  let catalog = 0;
  let availability = 0;
  return {
    startCatalog: () => ++catalog,
    isCurrentCatalog: (version: number) => version === catalog,
    cancelCatalog: () => { catalog += 1; },
    startAvailability: () => ++availability,
    isCurrentAvailability: (version: number) => version === availability,
    cancelAvailability: () => { availability += 1; },
  };
}

/** The order POST has already succeeded. A failed list refresh must never be
 * mistaken for a failed booking or trigger another booking POST. */
export async function syncConfirmedRouteBooking(refreshOrders: () => Promise<void>): Promise<boolean> {
  try {
    await refreshOrders();
    return true;
  } catch {
    return false;
  }
}

/** HTTP timeouts can occur after a successful server commit. Only such outcomes
 * keep booking disabled until an authoritative order list is inspected. */
export function routeBookingOutcomeUncertain(error: { status?: number; code?: string }): boolean {
  return error.code === "REQUEST_TIMEOUT" || error.code === "NETWORK_ERROR" ||
    (error.code === "INVALID_RESPONSE" && error.status !== undefined &&
      error.status >= 200 && error.status < 300);
}

/** Only known rejections from before the order transaction may unlock a new
 * booking. A generic conflict or server/proxy failure needs reconciliation. */
export function routeBookingDefinitivelyRejected(error: { status?: number; code?: string }): boolean {
  return error.status !== undefined && error.status >= 400 && error.status < 500 && [
    "NO_DRIVERS", "ROUTE_CHANGED", "ROUTE_NOT_FOUND", "ROUTE_INACTIVE", "ROUTE_STOP_NOT_FOUND",
    "INVALID_ROUTE_SEGMENT", "ROUTE_NOT_CONFIGURED", "ROUTE_STOP_NOT_CONFIGURED", "OUTSIDE_PICKUP_GEOFENCE",
    "MOCKED_GPS", "GPS_SPEED_LIMIT", "INVALID_COORDINATES", "VALIDATION_ERROR", "INVALID_IDEMPOTENCY_KEY",
    "UNAUTHORIZED", "FORBIDDEN",
  ].includes(error.code ?? "");
}

/** A displayed quote must still be fresh when the GPS lookup finishes.
 * This is a client UX guard; the server remains the booking authority. */
export function isFreshPassengerRouteQuote(
  quote: { key: string; checkedAt: number; value: { available: boolean } } | null,
  selectedKey: string,
  now: number,
): boolean {
  return !!selectedKey && !!quote && quote.key === selectedKey &&
    quote.value.available === true &&
    Number.isFinite(now) && Number.isFinite(quote.checkedAt) &&
    now >= quote.checkedAt && now - quote.checkedAt < 15_000;
}

/** Keep a failed route-catalog request distinct from a genuinely empty catalog.
 * The passenger can retry a failed fetch without changing account or server.
 */
export function passengerRouteCatalogStatus(input: {
  loading: boolean; error: string; count: number;
}): "loading" | "error" | "empty" | "ready" {
  if (input.loading) return "loading";
  if (input.error) return "error";
  return input.count > 0 ? "ready" : "empty";
}

/** Synchronous single-flight guard for a passenger booking attempt.
 * React's disabled button state applies on the next render, so two taps in the
 * same frame must be stopped before asking for GPS or posting an order. */
export function createPassengerRouteSubmissionGuard() {
  let inFlight = false;
  return {
    tryStart(): boolean {
      if (inFlight) return false;
      inFlight = true;
      return true;
    },
    finish(): void { inFlight = false; },
    isInFlight(): boolean { return inFlight; },
  };
}

/** Persist a booking attempt before the POST so restarting the app cannot erase
 * an uncertain server commit. Never store tokens, names, or GPS coordinates. */
export type RouteBookingRecovery = {
  status: "in_flight" | "confirmed" | "uncertain";
  orderId: string | null;
  requestKey?: string;
};

export function routeBookingRequestKey(value: unknown): string {
  if (typeof value !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error("Сервер не подтвердил ключ заказа. Повторное оформление заблокировано.");
  }
  return value.toLowerCase();
}

/** A 404 is not proof that the earlier POST cannot still commit. Never clear
 * the record or create another booking merely because lookup found no order. */
export async function reconcileRouteBookingRequest(
  record: RouteBookingRecovery,
  lookup: (path: string) => Promise<unknown>,
): Promise<RouteBookingRecovery> {
  if (record.status === "confirmed" || !record.requestKey) return record;
  const key = routeBookingRequestKey(record.requestKey);
  const response = await lookup("/api/orders/route/requests/" + encodeURIComponent(key));
  const order = response && typeof response === "object" ? (response as {order?: {id?: unknown}}).order : undefined;
  if (!order || typeof order.id !== "string" || !/^[a-z0-9-]{1,128}$/i.test(order.id)) {
    throw new Error("Не удалось подтвердить конкретный заказ. Повтори проверку статуса.");
  }
  return { status: "confirmed", orderId: order.id, requestKey: key };
}
export type RouteBookingStorage = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<unknown>;
  removeItem(key: string): Promise<unknown>;
};

export function routeBookingRecoveryKey(endpoint: string, userId: string): string {
  if (!/^https?:\/\//.test(endpoint) || !userId.trim()) {
    throw new Error("Booking recovery requires a valid endpoint and authenticated passenger.");
  }
  return "@onay/route-booking/v1/" + encodeURIComponent(endpoint) + "/" + encodeURIComponent(userId);
}

export async function readRouteBookingRecovery(storage: RouteBookingStorage, key: string): Promise<RouteBookingRecovery | null> {
  const value = await storage.getItem(key);
  if (value === null) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const data = parsed as Record<string, unknown>;
      const requestKey = data.requestKey === undefined ? {} : { requestKey: routeBookingRequestKey(data.requestKey) };
      if (data.status === "confirmed" && typeof data.orderId === "string" &&
          /^[a-z0-9-]{1,128}$/i.test(data.orderId)) {
        return { status: "confirmed", orderId: data.orderId, ...requestKey };
      }
      if (data.status === "in_flight" || data.status === "uncertain") {
        return { status: data.status, orderId: null, ...requestKey };
      }
    }
  } catch { /* Fail closed on truncated or legacy records. */ }
  return { status: "uncertain", orderId: null };
}

export async function saveRouteBookingRecovery(
  storage: RouteBookingStorage, key: string, state: RouteBookingRecovery,
): Promise<void> {
  if (state.status === "confirmed" && !state.orderId) throw new Error("Confirmed bookings require a server order id.");
  await storage.setItem(key, JSON.stringify({ status: state.status, orderId: state.orderId,
    ...(state.requestKey === undefined ? {} : { requestKey: routeBookingRequestKey(state.requestKey) }),
  }));
}

export async function clearRouteBookingRecovery(storage: RouteBookingStorage, key: string): Promise<void> {
  await storage.removeItem(key);
}

/** Safe only when the caller knows it has not started the POST. */
export async function discardUnsentRouteBooking(storage: RouteBookingStorage, key: string, requestKey: string): Promise<void> {
  const record = await readRouteBookingRecovery(storage, key);
  if (record?.status === "in_flight" && record.requestKey === requestKey) {
    await clearRouteBookingRecovery(storage, key);
  }
}

/** A successful orders GET is not enough: the exact confirmed order must be
 * visible before permitting another booking. An uncertain POST stays blocked. */
export function confirmedRouteBookingPresent(
  record: RouteBookingRecovery | null,
  orders: readonly { id: string }[],
): boolean {
  return record?.status === "confirmed" && !!record.orderId &&
    orders.some(order => order.id === record.orderId);
}

export type PassengerRouteSelection = {
  route_id: string;
  direction: DriverDirection;
  expected_updated_at: string;
  seats: number;
  pickup_stop_id?: string;
  destination_stop_id?: string;
};

export type PassengerRouteSegment = { pickupStopId: string; destinationStopId: string };

export type PassengerRouteAvailability = {
  available: boolean;
  eligibleDriverCount: number;
  priceKzt: number;
  currency: "KZT";
};

function validText(value: string): boolean { return Boolean(value && value.trim()); }

export function passengerRouteSelection(
  route: DriverRouteOption, direction: DriverDirection, seats: number, segment?: PassengerRouteSegment,
): PassengerRouteSelection {
  if (!validText(route.id) || !validText(route.updatedAt) ||
      (direction !== "a_to_b" && direction !== "b_to_a") ||
      !Number.isSafeInteger(seats) || seats < 1 || seats > 8 ||
      route.stops.length < 2) {
    throw new Error("Выбери действующий маршрут, направление и количество пассажиров.");
  }
  if (segment) {
    const stops = direction === "a_to_b" ? route.stops : [...route.stops].reverse();
    const pickupIndex = stops.findIndex(stop => stop.id === segment.pickupStopId);
    const destinationIndex = stops.findIndex(stop => stop.id === segment.destinationStopId);
    if (!validText(segment.pickupStopId) || !validText(segment.destinationStopId) ||
        pickupIndex < 0 || destinationIndex < 0 || pickupIndex >= destinationIndex) {
      throw new Error("Выбери разные остановки: посадка должна быть раньше назначения по направлению поездки.");
    }
  }
  return { route_id: route.id, direction, expected_updated_at: route.updatedAt, seats,
    ...(segment ? { pickup_stop_id: segment.pickupStopId, destination_stop_id: segment.destinationStopId } : {}),
  };
}

export function passengerRouteSelectionKey(selection: PassengerRouteSelection): string {
  return JSON.stringify([selection.route_id, selection.direction, selection.expected_updated_at, selection.seats,
    selection.pickup_stop_id ?? null, selection.destination_stop_id ?? null]);
}

export function passengerRouteAvailabilityPath(selection: PassengerRouteSelection): string {
  return "/api/orders/route/availability?" + new URLSearchParams({
    route_id: selection.route_id, direction: selection.direction,
    expected_updated_at: selection.expected_updated_at, seats: String(selection.seats),
    ...(selection.pickup_stop_id === undefined ? {} : { pickup_stop_id: selection.pickup_stop_id }),
    ...(selection.destination_stop_id === undefined ? {} : { destination_stop_id: selection.destination_stop_id }),
  }).toString();
}

/** Server is the only price/eligibility authority. Reject incomplete responses. */
export function parsePassengerRouteAvailability(body: unknown): PassengerRouteAvailability {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new Error("Сервер вернул неверные данные о водителях.");
  const value = body as Record<string, unknown>;
  const fare = value.fare;
  if (!fare || typeof fare !== "object" || Array.isArray(fare))
    throw new Error("Сервер не рассчитал стоимость поездки.");
  const quote = fare as Record<string, unknown>;
  if (typeof value.available !== "boolean" ||
      !Number.isSafeInteger(value.eligible_driver_count) ||
      (value.eligible_driver_count as number) < 0 ||
      !Number.isSafeInteger(quote.totalKzt) ||
      (quote.totalKzt as number) < 0 || quote.currency !== "KZT" ||
      (value.available === true && value.eligible_driver_count === 0)) {
    throw new Error("Данные о водителях или стоимости недостоверны. Обнови проверку.");
  }
  return {
    available: value.available, eligibleDriverCount: value.eligible_driver_count as number,
    priceKzt: quote.totalKzt as number, currency: "KZT",
  };
}

/** Preserve the selected segment; only the server resolves its geometry and fare. */
export function passengerRouteOrderBody(selection: PassengerRouteSelection, pickupLocation: {
  lat: number; lng: number; timestamp: number; isMocked?: boolean;
}) {
  if (!Number.isFinite(pickupLocation.lat) || !Number.isFinite(pickupLocation.lng) ||
      Math.abs(pickupLocation.lat) > 90 || Math.abs(pickupLocation.lng) > 180 ||
      !Number.isFinite(pickupLocation.timestamp) || pickupLocation.timestamp <= 0 ||
      pickupLocation.isMocked === true) {
    throw new Error("Не удалось подтвердить местоположение пассажира.");
  }
  return { ...selection, pickup_location: pickupLocation };
}
