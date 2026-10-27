/**
 * Passenger UI presentation only. The server is authoritative on eligibility and
 * rechecks seat reservations when an order is created. No local booking decision.
 */
export type PassengerAvailability = {
  pickup: string;
  seats: number;
  available: boolean;
  eligibleDriverCount: number | null;
  checkedAt: number;
};

export type AvailabilityDisplayState = "checking" | "error" | "stale" | "available" | "unavailable";

export function verifiedDriverCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value : null;
}

export function passengerAvailabilityDisplay(input: {
  availability: PassengerAvailability | null;
  pickup: string;
  seats: number;
  now: number;
  checking: boolean;
  error?: string;
}): { state: AvailabilityDisplayState; label: string } {
  if (input.checking) return { state: "checking", label: "Проверяем подходящих водителей…" };
  if (input.error) return { state: "error", label: "Не удалось проверить наличие водителей." };
  const current = input.availability;
  if (!current || !input.pickup || current.pickup !== input.pickup ||
      current.seats !== input.seats || input.now < current.checkedAt ||
      input.now - current.checkedAt >= 15_000) {
    return { state: "stale", label: "Наличие неизвестно. Нажми «Проверить наличие водителей»." };
  }
  if (!current.available) return { state: "unavailable", label: "Подходящих водителей сейчас нет." };
  return { state: "available", label: current.eligibleDriverCount !== null && current.eligibleDriverCount > 0
    ? `Подходящих водителей: ${current.eligibleDriverCount}`
    : "Есть подходящий водитель." };
}
