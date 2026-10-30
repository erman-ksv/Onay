import type { OrderStatus } from "../types/domain";

type Currency = "KZT" | "UZS";
type FareTotal = { currency: Currency; total: number; orders: number };
const amount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Read frozen totals, never a current tariff, seat multiplier or exchange rate. */
function frozenMoney(input: unknown): { currency: Currency; total: number } | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const fare = input as Record<string, unknown>;
  const has = (key: string) => Object.prototype.hasOwnProperty.call(fare, key);
  if (fare.currency !== "KZT" && fare.currency !== "UZS") return null;
  if (fare.currency === "UZS" && (has("totalKzt") || has("pricePerStopKzt"))) return null;
  const total = has("total") ? fare.total : fare.currency === "KZT" ? fare.totalKzt : undefined;
  if (!amount(total) || (has("totalKzt") && (!amount(fare.totalKzt) || fare.totalKzt !== total))) return null;
  return { currency: fare.currency, total };
}

/** Counts and fares describe the same authorized store snapshot. No PII leaves it. */
export function buildTripStatistics(orders: readonly { status: OrderStatus; fare?: unknown }[]) {
  const byStatus: Record<OrderStatus, number> = {
    searching: 0, en_route_to_c: 0, arrived_at_c: 0, boarded_waiting: 0,
    in_transit: 0, completed: 0, cancelled: 0,
  };
  const totals = new Map<Currency, FareTotal>();
  let missing = 0, overflow = false;
  for (const order of orders) {
    byStatus[order.status]++;
    if (order.status !== "completed") continue;
    const money = frozenMoney(order.fare);
    if (!money) { missing++; continue; }
    const previous = totals.get(money.currency) ?? { currency: money.currency, total: 0, orders: 0 };
    const total = previous.total + money.total;
    if (!amount(total)) { overflow = true; continue; }
    totals.set(money.currency, { currency: money.currency, total, orders: previous.orders + 1 });
  }
  return {
    // Preserve the existing statistics contract exactly; fare_summary is additive.
    statistics: {
      total: orders.length, active: orders.length - byStatus.completed - byStatus.cancelled,
      completed: byStatus.completed, cancelled: byStatus.cancelled, by_status: byStatus,
    },
    fare_summary: {
      basis: "completed_order_fares" as const, missing_fare_orders: missing, overflow,
      // Never publish a partial or rounded aggregate as the complete fare sum.
      totals: missing || overflow ? null : [...totals.values()].sort((a, b) => a.currency.localeCompare(b.currency)),
    },
  };
}
