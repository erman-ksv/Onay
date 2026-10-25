import { AdminApiError, adminRequest } from "./api.ts";

export const adminOrderStatuses = ["searching", "en_route_to_c", "arrived_at_c", "boarded_waiting", "in_transit", "completed", "cancelled"] as const;
export type AdminOrderStatus = typeof adminOrderStatuses[number];
export type AdminOrderFilter = "all" | "active" | AdminOrderStatus;
export const adminOrderStatusLabels: Record<AdminOrderStatus, string> = {
  searching: "Поиск водителя", en_route_to_c: "Едет к точке посадки", arrived_at_c: "Прибыл к точке посадки",
  boarded_waiting: "Ожидает отправления", in_transit: "В пути", completed: "Завершён", cancelled: "Отменён",
};
export type AdminOrder = {
  id: string; passengerId: string; driverId?: string; offeredDriverId?: string;
  status: AdminOrderStatus; seats: number; createdAt: string; updatedAt: string;
  pickup: string; destination: string; currency: "UZS" | "KZT"; total: number;
};
export const isClosedAdminOrder = (order: Pick<AdminOrder, "status">) => order.status === "completed" || order.status === "cancelled";

function parseOrder(value: unknown): AdminOrder {
  const bad = () => new AdminApiError(502, "Некорректные данные заказа. Обновите список.");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw bad();
  const order = value as Record<string, unknown>;
  const text = (key: string) => typeof order[key] === "string" && order[key] ? order[key] as string : undefined;
  if (!text("id") || !text("passenger_id") || !adminOrderStatuses.includes(order.status as AdminOrderStatus) ||
    !Number.isInteger(order.seats) || Number(order.seats) < 1 || Number(order.seats) > 8 ||
    !text("created_at") || !Number.isFinite(Date.parse(text("created_at")!)) || !text("updated_at") || !Number.isFinite(Date.parse(text("updated_at")!))) throw bad();
  if (!order.fare || typeof order.fare !== "object" || Array.isArray(order.fare)) throw bad();
  const fare = order.fare as Record<string, unknown>;
  const currency = fare.currency;
  const total = fare.total !== undefined ? fare.total : (currency === "KZT" ? fare.totalKzt : undefined);
  if ((currency !== "UZS" && currency !== "KZT") || typeof total !== "number" || !Number.isSafeInteger(total) || total < 0 ||
    (currency === "UZS" && (fare.totalKzt !== undefined || fare.pricePerStopKzt !== undefined)) ||
    (currency === "KZT" && fare.totalKzt !== undefined && fare.totalKzt !== total)) throw bad();
  const stopName = (stop: unknown) => stop && typeof stop === "object" && "name" in stop && typeof stop.name === "string" ? stop.name : undefined;
  // Only fields required for operations; passenger phone, GPS and arbitrary payloads are not retained.
  return { id: text("id")!, passengerId: text("passenger_id")!, driverId: text("driver_id"), offeredDriverId: text("offered_driver_id"),
    status: order.status as AdminOrderStatus, seats: Number(order.seats), createdAt: text("created_at")!, updatedAt: text("updated_at")!,
    pickup: stopName(fare.pickupStop) ?? text("pickup_point") ?? "—", destination: stopName(fare.destinationStop) ?? text("destination") ?? "—", currency, total };
}
export async function loadAdminOrders(token: string, status: AdminOrderFilter, signal?: AbortSignal): Promise<AdminOrder[]> {
  if (!["all", "active", ...adminOrderStatuses].includes(status)) throw new AdminApiError(400, "Неверный фильтр заказов.");
  const result = await adminRequest<{ orders: unknown }>("/admin/orders?" + new URLSearchParams({ status }), { token, signal });
  if (!result || !Array.isArray(result.orders)) throw new AdminApiError(502, "Некорректный список заказов.");
  const orders = result.orders.map(parseOrder);
  if (new Set(orders.map(order => order.id)).size !== orders.length) throw new AdminApiError(502, "Повторяющиеся записи заказов. Обновите список.");
  return orders.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}
export async function cancelAdminOrder(token: string, order: AdminOrder, signal?: AbortSignal): Promise<AdminOrder> {
  if (isClosedAdminOrder(order) || !adminOrderStatuses.includes(order.status)) throw new AdminApiError(400, "Закрытый заказ нельзя отменить.");
  const result = await adminRequest<{ order: unknown }>(`/admin/orders/${encodeURIComponent(order.id)}/cancel`, {
    token, signal, method: "POST", body: { expected_status: order.status },
  });
  const cancelled = parseOrder(result?.order);
  if (cancelled.id !== order.id || cancelled.status !== "cancelled") throw new AdminApiError(502, "Результат отмены не подтверждён. Обновите список.");
  return cancelled;
}
