import { AdminApiError, adminRequest } from "./api.ts";
import { isClosedAdminOrder, loadAdminOrders, type AdminOrder } from "./orders-api.ts";

export type AdminQueueLane = { kind: "legacy" } | {
  kind: "configured"; routeId: string; routeName: string;
  direction: "a_to_b" | "b_to_a"; pitak: "A" | "B";
  stopCode: string; stopName: string; routeUpdatedAt: string;
};
const queueStatuses = ["searching", "picking_up", "en_route_to_c", "arrived_at_c", "in_transit"] as const;
export type AdminQueueRow = {
  driverId: string; position: number; joinedAt: number;
  status: typeof queueStatuses[number]; availableSeats: number; lane: AdminQueueLane;
};
export type AdminMonitoringSnapshot = { orders: AdminOrder[]; queue: AdminQueueRow[] };

const badQueue = () => new AdminApiError(502, "Некорректные данные очереди. Обновите мониторинг.");
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw badQueue();
  return value as Record<string, unknown>;
}
function text(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  if (typeof value !== "string" || !value.trim()) throw badQueue();
  return value;
}
function lane(value: unknown): AdminQueueLane {
  const source = record(value);
  if (source.kind === "legacy") return { kind: "legacy" };
  if (source.kind !== "configured" ||
    !((source.direction === "a_to_b" && source.pitak === "A") || (source.direction === "b_to_a" && source.pitak === "B"))) throw badQueue();
  const updated = text(source, "route_updated_at");
  if (!Number.isFinite(Date.parse(updated))) throw badQueue();
  return {
    kind: "configured", routeId: text(source, "route_id"), routeName: text(source, "route_name"),
    direction: source.direction, pitak: source.pitak, stopCode: text(source, "stop_code"),
    stopName: text(source, "stop_name"), routeUpdatedAt: updated,
  };
}
function queue(value: unknown): AdminQueueRow[] {
  const result = record(value);
  if (!Array.isArray(result.queue) || !Number.isSafeInteger(result.total_queued) || result.total_queued !== result.queue.length) throw badQueue();
  const seen = new Set<string>();
  return result.queue.map((value: unknown) => {
    const row = record(value), driverId = text(row, "driver_id");
    if (seen.has(driverId) || !Number.isSafeInteger(row.position) || Number(row.position) < 1 ||
      typeof row.joined_at !== "number" || !Number.isFinite(row.joined_at) || row.joined_at < 0 ||
      !Number.isInteger(row.available_seats) || Number(row.available_seats) < 0 || Number(row.available_seats) > 8 ||
      !queueStatuses.includes(row.status as AdminQueueRow["status"])) throw badQueue();
    seen.add(driverId);
    // Retain only the fields needed by monitoring; GPS, locks and arbitrary payloads are discarded.
    return { driverId, position: Number(row.position), joinedAt: row.joined_at,
      status: row.status as AdminQueueRow["status"], availableSeats: Number(row.available_seats), lane: lane(row.lane) };
  });
}

/** Both reads must succeed before publishing a snapshot. They are independent HTTP reads, not a database transaction. */
export async function loadAdminMonitoring(token: string, signal?: AbortSignal): Promise<AdminMonitoringSnapshot> {
  const [orders, queueResult] = await Promise.all([
    loadAdminOrders(token, "active", signal),
    adminRequest<unknown>("/admin/queue?include_lanes=true", { token, signal }),
  ]);
  if (orders.some(isClosedAdminOrder)) throw new AdminApiError(502, "Сервер вернул закрытый заказ в активных поездках. Обновите мониторинг.");
  return { orders, queue: queue(queueResult) };
}
