import { AdminApiError, adminRequest } from "./api.ts";

export const tripStatuses = ["searching", "en_route_to_c", "arrived_at_c", "boarded_waiting", "in_transit", "completed", "cancelled"] as const;
type Status = typeof tripStatuses[number];
export type TripStatistics = {
  statistics: { total: number; active: number; completed: number; cancelled: number; by_status: Record<Status, number> };
  fare_summary: { basis: "completed_order_fares"; missing_fare_orders: number; overflow: boolean;
    totals: { currency: "KZT" | "UZS"; total: number; orders: number }[] | null };
};
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const bad = () => new AdminApiError(502, "Некорректная статистика. Повторите обновление.");
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw bad();
  return value as Record<string, unknown>;
}
export function parseTripStatistics(input: unknown): TripStatistics {
  const root = record(input), stats = record(root.statistics), by = record(stats.by_status), fare = record(root.fare_summary);
  for (const key of ["total", "active", "completed", "cancelled"]) if (!count(stats[key])) throw bad();
  for (const key of tripStatuses) if (!count(by[key])) throw bad();
  const total = tripStatuses.reduce((sum, key) => sum + Number(by[key]), 0);
  if (!count(total) || total !== stats.total || by.completed !== stats.completed || by.cancelled !== stats.cancelled ||
    total - Number(stats.completed) - Number(stats.cancelled) !== stats.active ||
    fare.basis !== "completed_order_fares" || !count(fare.missing_fare_orders) || fare.missing_fare_orders > Number(stats.completed) || typeof fare.overflow !== "boolean") throw bad();
  const incomplete = fare.missing_fare_orders > 0 || fare.overflow;
  if (incomplete ? fare.totals !== null : !Array.isArray(fare.totals)) throw bad();
  let totals: TripStatistics["fare_summary"]["totals"] = null;
  if (!incomplete) {
    const seen = new Set<string>();
    totals = (fare.totals as unknown[]).map(raw => {
      const row = record(raw);
      if ((row.currency !== "KZT" && row.currency !== "UZS") || seen.has(row.currency) || !count(row.total) || !count(row.orders) || row.orders < 1) throw bad();
      seen.add(row.currency);
      return { currency: row.currency, total: row.total, orders: row.orders };
    });
    if (totals.reduce((sum, row) => sum + row.orders, 0) !== stats.completed) throw bad();
  }
  // Keep only aggregate fields; unexpected identities or raw orders are discarded.
  return { statistics: { total: Number(stats.total), active: Number(stats.active), completed: Number(stats.completed), cancelled: Number(stats.cancelled),
      by_status: Object.fromEntries(tripStatuses.map(key => [key, Number(by[key])])) as Record<Status, number> },
    fare_summary: { basis: "completed_order_fares", missing_fare_orders: fare.missing_fare_orders, overflow: fare.overflow, totals } };
}
export async function loadTripStatistics(token: string, signal?: AbortSignal): Promise<TripStatistics> {
  return parseTripStatistics(await adminRequest<unknown>("/admin/statistics/trips", { token, signal }));
}
