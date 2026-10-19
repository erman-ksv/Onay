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
