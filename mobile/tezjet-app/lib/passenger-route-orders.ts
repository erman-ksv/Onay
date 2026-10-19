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

export type PassengerRouteSelection = {
  route_id: string;
  direction: DriverDirection;
  expected_updated_at: string;
  seats: number;
};

export type PassengerRouteAvailability = {
  available: boolean;
  eligibleDriverCount: number;
  priceKzt: number;
  currency: "KZT";
};

function validText(value: string): boolean { return Boolean(value && value.trim()); }

export function passengerRouteSelection(
  route: DriverRouteOption, direction: DriverDirection, seats: number,
): PassengerRouteSelection {
  if (!validText(route.id) || !validText(route.updatedAt) ||
      (direction !== "a_to_b" && direction !== "b_to_a") ||
      !Number.isSafeInteger(seats) || seats < 1 || seats > 8 ||
      route.stops.length < 2) {
    throw new Error("Выбери действующий маршрут, направление и количество пассажиров.");
  }
  return { route_id: route.id, direction, expected_updated_at: route.updatedAt, seats };
}

export function passengerRouteSelectionKey(selection: PassengerRouteSelection): string {
  return JSON.stringify([selection.route_id, selection.direction, selection.expected_updated_at, selection.seats]);
}

export function passengerRouteAvailabilityPath(selection: PassengerRouteSelection): string {
  return "/api/orders/route/availability?" + new URLSearchParams({
    route_id: selection.route_id, direction: selection.direction,
    expected_updated_at: selection.expected_updated_at, seats: String(selection.seats),
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

/** Defaults to full trip in the selected direction; server resolves stops. */
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
