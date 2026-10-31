/**
 * Admin portal API client.
 *
 * Credentials are held only in React memory; this module never persists,
 * logs, or embeds them into URLs. The server still enforces admin JWT access.
 * In development Vite proxies /api to the TezJet backend.
 */
export type AdminRecord = {
  id: string;
  role: string;
  roles: string[];
  full_name: string;
  phone_number: string;
  driver_approval_status?: "pending" | "approved" | "rejected" | "blocked";
  driver_vehicle?: { revision: string; make: string; model: string; plate_number: string; seat_capacity: number; updated_at: string };
  created_at: string;
};

export type AdminSession = {
  token: string;
  user: AdminRecord;
};

export type OtpRequestResult = {
  expires_in_seconds: number;
  demo_code?: string;
};

export class AdminApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "AdminApiError";
  }
}

type Options = {
  method?: "GET" | "POST" | "PUT" | "PATCH";
  token?: string;
  body?: unknown;
  signal?: AbortSignal;
};

/** Always use the same-origin /api route (Vite proxy in development). */
export async function adminRequest<T>(path: string, options: Options = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.token) headers.Authorization = "Bearer " + options.token;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";

  const response = await fetch("/api" + path, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal,
    credentials: "omit",
    cache: "no-store",
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = payload as { error?: { message?: string; code?: string } } | null;
    throw new AdminApiError(
      response.status,
      error?.error?.message || "Сервер вернул ошибку " + response.status,
      error?.error?.code,
    );
  }
  return payload as T;
}

export async function sendAdminOtp(
  phone: string,
  name: string,
): Promise<OtpRequestResult> {
  return adminRequest<OtpRequestResult>("/auth/request-otp", {
    method: "POST",
    body: { phone_number: phone.trim(), full_name: name.trim(), role: "admin", locale: "ru" },
  });
}

export async function verifyAdminOtp(phone: string, code: string): Promise<AdminSession> {
  const result = await adminRequest<{ access_token: string; user: AdminRecord }>(
    "/auth/verify-otp",
    { method: "POST", body: { phone_number: phone.trim(), code: code.trim() } },
  );
  if (!result.access_token || result.user?.role !== "admin") {
    throw new AdminApiError(403, "Доступ разрешён только администратору TezJet.");
  }
  return { token: result.access_token, user: result.user };
}

function isDirectory(value: unknown, capability: "passenger" | "driver"): value is AdminRecord[] {
  if (!Array.isArray(value)) return false;
  const ids = new Set<string>();
  return value.every(user => {
    if (!user || typeof user !== "object" || typeof user.id !== "string" || !user.id ||
        ids.has(user.id) || typeof user.full_name !== "string" ||
        typeof user.phone_number !== "string" || !Array.isArray(user.roles) ||
        !user.roles.includes(capability) || !["passenger", "driver", "admin"].includes(user.role)) return false;
    ids.add(user.id);
    return true;
  });
}

/** Search the loaded snapshot only; never send personal search text in URLs. */
export function filterDirectory(users: AdminRecord[], query: string): AdminRecord[] {
  const text = query.trim().normalize("NFKC").toLocaleLowerCase("ru");
  const phone = /^\+?[\d\s().-]+$/.test(text) ? text.replace(/\D/g, "") : "";
  return users.filter(user => !text ||
    [user.full_name, user.phone_number, user.id].some(value => value.normalize("NFKC").toLocaleLowerCase("ru").includes(text)) ||
    (phone.length > 0 && user.phone_number.replace(/\D/g, "").includes(phone)));
}

export async function loadDirectories(token: string, signal?: AbortSignal): Promise<{
  passengers: AdminRecord[];
  drivers: AdminRecord[];
}> {
  const [p, d] = await Promise.all([
    adminRequest<{ passengers: AdminRecord[] }>("/admin/passengers", { token, signal }),
    adminRequest<{ drivers: AdminRecord[] }>("/admin/drivers", { token, signal }),
  ]);
  if (!isDirectory(p?.passengers, "passenger") || !isDirectory(d?.drivers, "driver")) {
    throw new AdminApiError(502, "Некорректный ответ каталога пользователей.");
  }
  return { passengers: p.passengers, drivers: d.drivers };
}

export async function closeAdminSession(token: string): Promise<void> {
  await adminRequest<void>("/auth/logout", { token, method: "POST" });
}

export async function reviewDriverVehicle(token: string, driverId: string, status: "approved" | "rejected", revision: string): Promise<AdminRecord> {
  const result = await adminRequest<{ driver: AdminRecord }>(`/admin/drivers/${encodeURIComponent(driverId)}/approval`, {
    token, method: "PATCH", body: { status, expected_vehicle_revision: revision },
  });
  if (!result.driver || result.driver.id !== driverId || result.driver.driver_vehicle?.revision !== revision || result.driver.driver_approval_status !== status) {
    throw new AdminApiError(502, "Не удалось подтвердить результат проверки автомобиля.");
  }
  return result.driver;
}

export type AdminRouteStop = {
  id: string;
  code: string;
  name: string;
  sequence: number;
  position: number;
  location?: { lat: number; lng: number; timestamp?: number };
};

export type AdminRoute = {
  id: string;
  name: string;
  active: boolean;
  currency: "KZT" | "UZS";
  pricePerStop?: number;
  pricePerStopKzt?: number;
  updatedAt: string;
  stops: AdminRouteStop[];
  pitaks?: { aStopCode: string; bStopCode: string; radiusMeters: number };
};

export type RouteLayoutInput = {
  expected_updated_at: string;
  stops: Array<{ id?: string; code: string; name: string; location?: { lat: number; lng: number } }>;
  pitaks?: { a_stop_code: string; b_stop_code: string; radius_meters: number };
};

/** A currency is never inferred from the numeric size or re-labelled. */
export function adminRoutePrice(route: Pick<AdminRoute, "currency" | "pricePerStop" | "pricePerStopKzt">): number {
  const price = route.currency === "KZT" ? route.pricePerStopKzt ?? route.pricePerStop : route.pricePerStop;
  if ((route.currency !== "KZT" && route.currency !== "UZS") ||
      typeof price !== "number" || !Number.isSafeInteger(price) || price < 0 || price > 1_000_000_000 ||
      (route.currency === "UZS" && route.pricePerStopKzt !== undefined) ||
      (route.currency === "KZT" && route.pricePerStop !== undefined && route.pricePerStop !== price)) {
    throw new AdminApiError(502, "Валюта или тариф маршрута некорректны.");
  }
  return price;
}

export function adminCurrencyLabel(currency: AdminRoute["currency"]): string {
  return currency === "UZS" ? "сум" : "₸";
}

export function readTariffDraft(value: string): number {
  if (!/^\d+$/.test(value.trim())) throw new Error("Введите целый тариф от 0 до 1 000 000 000.");
  const price = Number(value.trim());
  if (!Number.isSafeInteger(price) || price > 1_000_000_000) throw new Error("Тариф не должен превышать 1 000 000 000.");
  return price;
}

function readRoute(value: unknown): AdminRoute {
  const route = value as AdminRoute | undefined;
  if (!route || typeof route.id !== "string" || typeof route.name !== "string" ||
      typeof route.updatedAt !== "string" || !route.updatedAt || !Array.isArray(route.stops) ||
      route.stops.some(stop => !stop || typeof stop.id !== "string" || typeof stop.code !== "string" || typeof stop.name !== "string")) {
    throw new AdminApiError(502, "Некорректный ответ каталога маршрутов.");
  }
  adminRoutePrice(route);
  return route;
}

export async function loadAdminRoutes(token: string, signal?: AbortSignal): Promise<AdminRoute[]> {
  const result = await adminRequest<{ routes: unknown[] }>("/admin/routes", { token, signal });
  if (!Array.isArray(result.routes)) throw new AdminApiError(502, "Некорректный ответ каталога маршрутов.");
  return result.routes.map(readRoute);
}

export async function loadAdminRoute(token: string, routeId: string, signal?: AbortSignal): Promise<AdminRoute> {
  const result = await adminRequest<{ route: unknown }>("/admin/routes/" + encodeURIComponent(routeId), { token, signal });
  return readRoute(result.route);
}

/** New routes require an explicitly chosen currency and tariff. */
export async function createAdminRoute(token: string, name: string, currency: AdminRoute["currency"], price: number): Promise<AdminRoute> {
  const result = await adminRequest<{ route: unknown }>("/admin/routes", {
    token, method: "POST", body: { name: name.trim(), currency, price_per_stop: price },
  });
  const route = readRoute(result.route);
  if (route.currency !== currency || adminRoutePrice(route) !== price) throw new AdminApiError(502, "Сервер не подтвердил заданную валюту и тариф.");
  return route;
}

export async function saveAdminRouteTariff(token: string, routeId: string, price: number): Promise<AdminRoute> {
  const result = await adminRequest<{ route: unknown }>("/admin/routes/" + encodeURIComponent(routeId), {
    token, method: "PATCH", body: { price_per_stop: price },
  });
  const route = readRoute(result.route);
  if (route.id !== routeId || adminRoutePrice(route) !== price) throw new AdminApiError(502, "Сервер не подтвердил заданный тариф.");
  return route;
}

export async function saveAdminRouteLayout(token: string, routeId: string, layout: RouteLayoutInput): Promise<AdminRoute> {
  const result = await adminRequest<{ route: unknown }>("/admin/routes/" + encodeURIComponent(routeId) + "/layout", { token, method: "PUT", body: layout });
  return readRoute(result.route);
}



export type AdminAuditFilters = { orderId: string; driverId: string; routeId: string; limit: number };
export type AdminAuditEvent = {
  id: string; actorId: string; action: "order.cancelled" | "driver.approval_changed" | "route.updated" | "settings.offer_timeout_changed";
  createdAt: string; orderId?: string; driverId?: string; routeId?: string;
  fromStatus?: string; toStatus?: string; vehicleRevision?: string;
  settingKey?: "offer-timeout"; previousValue?: number; nextValue?: number;
  changedFields?: string[]; previousVersion?: string; nextVersion?: string;
};

/** Consume only the server's bounded audit window. It has no cursor or total-count API. */
export async function loadAdminAuditEvents(token: string, filters: AdminAuditFilters, signal?: AbortSignal): Promise<AdminAuditEvent[]> {
  if (!Number.isInteger(filters.limit) || filters.limit < 1 || filters.limit > 100) throw new AdminApiError(400, "Лимит событий должен быть от 1 до 100.");
  const query = new URLSearchParams({ limit: String(filters.limit) });
  for (const [name, raw] of [["order_id", filters.orderId], ["driver_id", filters.driverId], ["route_id", filters.routeId]] as const) {
    const value = raw.trim();
    if (value.length > 100) throw new AdminApiError(400, "ID в фильтре слишком длинный.");
    if (value) query.set(name, value);
  }
  const result = await adminRequest<{ events: unknown }>("/admin/audit-events?" + query, { token, signal });
  if (!result || !Array.isArray(result.events) || result.events.length > filters.limit) throw new AdminApiError(502, "Некорректный ответ журнала.");
  return result.events.map((value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new AdminApiError(502, "Некорректное событие журнала.");
    const event = value as Record<string, unknown>;
    const text = (key: string): string | undefined => typeof event[key] === "string" && event[key] ? event[key] as string : undefined;
    const action = text("action");
    if (!text("id") || !text("actorId") || !text("createdAt") || !Number.isFinite(Date.parse(text("createdAt")!)) ||
      !["order.cancelled", "driver.approval_changed", "route.updated", "settings.offer_timeout_changed"].includes(action ?? "")) throw new AdminApiError(502, "Некорректное событие журнала.");
    if (action === "order.cancelled" && (!text("orderId") || !text("fromStatus") || text("toStatus") !== "cancelled") ||
      action === "driver.approval_changed" && (!text("driverId") || !text("fromStatus") || !text("toStatus")) ||
      action === "route.updated" && (!text("routeId") || !Array.isArray(event.changedFields) || !event.changedFields.every(field => typeof field === "string") || !text("previousVersion") || !text("nextVersion"))) throw new AdminApiError(502, "Неполное событие журнала.");
    if (action === "settings.offer_timeout_changed" && (event.settingKey !== "offer-timeout" ||
      typeof event.previousValue !== "number" || !Number.isSafeInteger(event.previousValue) || event.previousValue < 1 || event.previousValue > 3600 ||
      typeof event.nextValue !== "number" || !Number.isSafeInteger(event.nextValue) || event.nextValue < 1 || event.nextValue > 3600 || !text("nextVersion"))) {
      throw new AdminApiError(502, "Некорректное изменение времени ответа.");
    }
    // Deliberately project known fields; raw payloads and any future personal data are not rendered.
    return { id: text("id")!, actorId: text("actorId")!, action: action as AdminAuditEvent["action"], createdAt: text("createdAt")!,
      orderId: text("orderId"), driverId: text("driverId"), routeId: text("routeId"), fromStatus: text("fromStatus"), toStatus: text("toStatus"),
      vehicleRevision: text("vehicleRevision"), changedFields: action === "route.updated" ? [...event.changedFields as string[]] : undefined,
      previousVersion: text("previousVersion"), nextVersion: text("nextVersion"),
      ...(action === "settings.offer_timeout_changed" ? { settingKey: "offer-timeout" as const, previousValue: event.previousValue as number, nextValue: event.nextValue as number } : {}) };
  });
}

/** Capture the displayed car receipt; a stale decision must never target a new car. */
export async function setDriverBlocked(token: string, driverId: string, blocked: boolean, revision: string | null): Promise<AdminRecord> {
  const result = await adminRequest<{ driver: AdminRecord }>(`/admin/drivers/${encodeURIComponent(driverId)}/block`, {
    token, method: "PATCH", body: { blocked, expected_vehicle_revision: revision },
  });
  const driver = result?.driver;
  if (!driver || driver.id !== driverId || (driver.driver_vehicle?.revision ?? null) !== revision ||
      (blocked ? driver.driver_approval_status !== "blocked" : !["pending", "approved", "rejected"].includes(driver.driver_approval_status ?? ""))) {
    throw new AdminApiError(502, "Не удалось подтвердить состояние блокировки. Обновите список.");
  }
  return driver;
}
