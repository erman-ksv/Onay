import { parseServerFareMoney, type FareMoney } from "./fare-money.ts";
import { isClosed, type RideOrder } from "./orders.ts";

export type DriverHistoryRow = { order: RideOrder; money: FareMoney | null };
export type DriverHistory = { rows: DriverHistoryRow[]; completed: number; totals: FareMoney[] | null };

/** Full authorized snapshot only. Offers and the driver's own passenger rides
 * are not work performed by this driver. Never multiply a frozen order total
 * by seats or merge currencies. Missing money makes the aggregate unknown. */
export function parseDriverHistory(input: unknown, driverId: string): DriverHistory {
  if (!driverId || !input || typeof input !== "object" || !Array.isArray((input as { orders?: unknown }).orders)) {
    throw new Error("Не удалось подтвердить историю поездок.");
  }
  const seen = new Set<string>();
  const rows: DriverHistoryRow[] = [];
  const totals = new Map<FareMoney["currency"], number>();
  let completed = 0, validTotals = true;
  for (const raw of (input as { orders: unknown[] }).orders) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Некорректная история поездок.");
    const order = raw as RideOrder;
    if (typeof order.id !== "string" || !order.id || seen.has(order.id) || typeof order.status !== "string") {
      throw new Error("Некорректная история поездок.");
    }
    seen.add(order.id);
    if (order.driver_id !== driverId || !isClosed(order)) continue;
    let money: FareMoney | null = null;
    try { money = parseServerFareMoney(order.fare); } catch { /* Legacy rides can lack a frozen fare. */ }
    rows.push({ order, money });
    if (order.status === "completed") {
      completed++;
      if (!money) { validTotals = false; continue; }
      const total = (totals.get(money.currency) ?? 0) + money.total;
      if (!Number.isSafeInteger(total)) validTotals = false;
      totals.set(money.currency, total);
    }
  }
  rows.sort((a, b) => (b.order.updated_at ?? b.order.created_at ?? "").localeCompare(a.order.updated_at ?? a.order.created_at ?? "") || a.order.id.localeCompare(b.order.id));
  return { rows, completed, totals: validTotals ? [...totals].sort(([a], [b]) => a.localeCompare(b)).map(([currency, total]) => ({ currency, total })) : null };
}
