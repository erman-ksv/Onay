import { parseServerFareMoney, type FareMoney } from "./fare-money.ts";
import { isClosed, type RideOrder } from "./orders.ts";

export type PassengerHistoryRow = { order: RideOrder; money: FareMoney | null };

/** Use the complete authorized response, but include only this account's
 * passenger rides. Driver work/offers are not passenger history. */
export function parsePassengerHistory(input: unknown, passengerId: string): PassengerHistoryRow[] {
  if (!passengerId || !input || typeof input !== "object" || !Array.isArray((input as { orders?: unknown }).orders)) {
    throw new Error("Не удалось подтвердить историю поездок.");
  }
  const seen = new Set<string>();
  const rows: PassengerHistoryRow[] = [];
  for (const raw of (input as { orders: unknown[] }).orders) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Некорректная история поездок.");
    const order = raw as RideOrder;
    if (typeof order.id !== "string" || !order.id || seen.has(order.id) || typeof order.status !== "string") {
      throw new Error("Некорректная история поездок.");
    }
    seen.add(order.id);
    if (order.passenger_id !== passengerId || !isClosed(order)) continue;
    if (!Number.isSafeInteger(order.seats) || order.seats < 1 || order.seats > 8) throw new Error("Некорректное число мест в истории.");
    let money: FareMoney | null = null;
    try { money = parseServerFareMoney(order.fare); } catch { /* Older rides can lack a frozen fare. */ }
    rows.push({ order, money });
  }
  return rows.sort((a, b) => historyDateKey(b.order.created_at).localeCompare(historyDateKey(a.order.created_at)) || a.order.id.localeCompare(b.order.id));
}

function historyDateKey(value: unknown): string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : "";
}

export function passengerHistoryDate(value: unknown): string {
  const key = historyDateKey(value);
  return key ? new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short" }).format(new Date(key)) : "Дата недоступна";
}
