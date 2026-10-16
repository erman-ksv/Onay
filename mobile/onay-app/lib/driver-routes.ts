export type DriverDirection = "a_to_b" | "b_to_a";
export type DriverRouteStop = { id: string; code: string; name: string; sequence: number; position: number };
export type DriverRouteOption = {
  id: string;
  name: string;
  updatedAt: string;
  stops: DriverRouteStop[];
  pitaks: { aStopCode: string; bStopCode: string; radiusMeters: number };
};
export type DriverRouteChoice = { routeId: string; direction: DriverDirection; routeUpdatedAt: string };
export type DriverRouteUnavailable = "ROUTE_MISSING" | "ROUTE_INACTIVE" | "ROUTE_CHANGED" | "ROUTE_NOT_CONFIGURED";
export type DriverRouteSnapshot = {
  choice: DriverRouteChoice | null;
  route: DriverRouteOption | null;
  unavailable_reason: DriverRouteUnavailable | null;
};
export type DriverRouteGate = {
  sessionKey: string; ready: boolean; hasChoice: boolean; mutating: boolean;
  choice?: DriverRouteChoice; routeAvailable?: boolean; pitak?: "A" | "B"; pitakName?: string;
};
export type DriverQueueContext = DriverRouteChoice & { routeName: string; pitak: "A" | "B"; stopName: string };

export class DriverRouteError extends Error {
  readonly status?: number;
  readonly code?: string;
  constructor(message: string, status?: number, code?: string) {
    super(message);
    this.name = "DriverRouteError";
    this.status = status;
    this.code = code;
  }
}

function invalidResponse(): never {
  throw new DriverRouteError("Не удалось прочитать маршруты Onay. Повтори обновление.", undefined, "INVALID_RESPONSE");
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalidResponse();
  return value as Record<string, unknown>;
}
function text(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
export function isDriverDirection(value: unknown): value is DriverDirection { return value === "a_to_b" || value === "b_to_a"; }

export function parseDriverRoute(value: unknown): DriverRouteOption {
  const route = record(value);
  if (!text(route.id) || !text(route.name) || !text(route.updatedAt) || !Array.isArray(route.stops) || route.stops.length < 2) return invalidResponse();
  const ids = new Set<string>(), codes = new Set<string>(), sequences = new Set<number>(), positions = new Set<number>();
  const stops = route.stops.map(value => {
    const stop = record(value);
    if (!text(stop.id) || !text(stop.code) || !text(stop.name) || typeof stop.sequence !== "number" || !Number.isSafeInteger(stop.sequence) || stop.sequence < 1 ||
        typeof stop.position !== "number" || !Number.isSafeInteger(stop.position) || stop.position < 1 ||
        ids.has(stop.id) || codes.has(stop.code) || sequences.has(stop.sequence) || positions.has(stop.position)) return invalidResponse();
    ids.add(stop.id); codes.add(stop.code); sequences.add(stop.sequence); positions.add(stop.position);
    return { id: stop.id, code: stop.code, name: stop.name, sequence: stop.sequence, position: stop.position };
  });
  if (stops.some((stop, index) => index > 0 && (stop.sequence <= stops[index - 1].sequence || stop.position <= stops[index - 1].position))) return invalidResponse();
  const pitaks = record(route.pitaks);
  if (!text(pitaks.aStopCode) || !text(pitaks.bStopCode) || pitaks.aStopCode === pitaks.bStopCode ||
      stops[0].code !== pitaks.aStopCode || stops[stops.length - 1].code !== pitaks.bStopCode ||
      typeof pitaks.radiusMeters !== "number" || !Number.isFinite(pitaks.radiusMeters) || pitaks.radiusMeters <= 0) return invalidResponse();
  return { id: route.id, name: route.name, updatedAt: route.updatedAt, stops,
    pitaks: { aStopCode: pitaks.aStopCode, bStopCode: pitaks.bStopCode, radiusMeters: pitaks.radiusMeters } };
}

export function parseDriverRouteCatalog(value: unknown): DriverRouteOption[] {
  const body = record(value);
  if (!Array.isArray(body.routes)) return invalidResponse();
  const routes = body.routes.map(parseDriverRoute);
  if (new Set(routes.map(route => route.id)).size !== routes.length) return invalidResponse();
  return routes;
}

export function parseDriverRouteSnapshot(value: unknown): DriverRouteSnapshot {
  const body = record(value);
  const reasons = ["ROUTE_MISSING", "ROUTE_INACTIVE", "ROUTE_CHANGED", "ROUTE_NOT_CONFIGURED"];
  if (body.unavailable_reason !== null && !reasons.includes(body.unavailable_reason as string)) return invalidResponse();
  if (body.choice === null) {
    if (body.route !== null || body.unavailable_reason !== null) return invalidResponse();
    return { choice: null, route: null, unavailable_reason: null };
  }
  const choice = record(body.choice);
  if (!text(choice.routeId) || !isDriverDirection(choice.direction) || !text(choice.routeUpdatedAt)) return invalidResponse();
  const route = body.route === null ? null : parseDriverRoute(body.route);
  if (body.unavailable_reason !== null && route !== null) return invalidResponse();
  if (route && route.id !== choice.routeId) return invalidResponse();
  if (body.unavailable_reason === null && (!route || route.updatedAt !== choice.routeUpdatedAt)) return invalidResponse();
  return { choice: { routeId: choice.routeId, direction: choice.direction, routeUpdatedAt: choice.routeUpdatedAt }, route,
    unavailable_reason: body.unavailable_reason as DriverRouteUnavailable | null };
}

export function orderedDriverStops(route: DriverRouteOption, direction: DriverDirection): DriverRouteStop[] {
  const stops = [...route.stops];
  return direction === "b_to_a" ? stops.reverse() : stops;
}

export function driverDirectionLabel(route: DriverRouteOption, direction: DriverDirection): string {
  const stops = orderedDriverStops(route, direction);
  return `${direction === "a_to_b" ? "A → B" : "B → A"}: ${stops[0].name} → ${stops[stops.length - 1].name}`;
}

/** Refresh the catalog version, preserving the driver's route and direction draft. */
export function refreshDriverRouteDraft(draft: DriverRouteChoice | null, routes: DriverRouteOption[]): DriverRouteChoice | null {
  if (!draft) return null;
  const route = routes.find(route => route.id === draft.routeId);
  return route ? { ...draft, routeUpdatedAt: route.updatedAt } : draft;
}

export function driverRouteSaveInput(draft: DriverRouteChoice | null, routes: DriverRouteOption[]) {
  const route = draft && routes.find(route => route.id === draft.routeId);
  if (!draft || !route || !isDriverDirection(draft.direction)) {
    throw new DriverRouteError("Выбери доступный маршрут и направление.", undefined, "VALIDATION_ERROR");
  }
  if (route.updatedAt !== draft.routeUpdatedAt) {
    throw new DriverRouteError("Маршрут изменился. Обнови список перед сохранением.", 409, "ROUTE_CHANGED");
  }
  return { route_id: draft.routeId, direction: draft.direction, expected_updated_at: draft.routeUpdatedAt };
}

export function driverRouteSessionKey(endpoint: string, token: string): string { return JSON.stringify([endpoint, token]); }
export function canJoinLegacyDriverQueue(gate: DriverRouteGate, sessionKey: string): boolean {
  return gate.sessionKey === sessionKey && gate.ready && !gate.hasChoice && !gate.mutating;
}
export function canJoinDriverQueue(gate: DriverRouteGate, sessionKey: string): boolean {
  return gate.sessionKey === sessionKey && gate.ready && !gate.mutating &&
    (!gate.hasChoice || Boolean(gate.choice && gate.routeAvailable));
}
export function driverQueueChoiceInput(gate: DriverRouteGate, sessionKey: string) {
  if (!canJoinDriverQueue(gate, sessionKey)) throw new DriverRouteError("Обнови сохранённый маршрут перед входом в очередь.");
  return gate.hasChoice && gate.choice ? {
    route_id: gate.choice.routeId, direction: gate.choice.direction, expected_updated_at: gate.choice.routeUpdatedAt,
  } : undefined;
}
export function canMutateDriverRoute(state: { busy: boolean; queued: boolean; activeTrip: boolean; pendingOffer: boolean }): boolean {
  return !state.busy && !state.queued && !state.activeTrip && !state.pendingOffer;
}

/** One scope per mounted session; old requests cannot overwrite a new session or draft. */
export function createDriverRouteRequestScope() {
  let sequence = 0, draftRevision = 0, disposed = false;
  let controller: AbortController | null = null;
  return {
    start() {
      controller?.abort();
      controller = new AbortController();
      return { sequence: ++sequence, draftRevision, signal: controller.signal };
    },
    editDraft() { draftRevision += 1; },
    isCurrent(ticket: { sequence: number; signal: AbortSignal }) { return !disposed && !ticket.signal.aborted && sequence === ticket.sequence; },
    draftUnchanged(ticket: { draftRevision: number }) { return ticket.draftRevision === draftRevision; },
    dispose() { disposed = true; sequence += 1; controller?.abort(); },
  };
}

export function createDriverRouteClient(endpoint: string, token: string, fetcher: typeof fetch = fetch) {
  async function send(path: string, signal: AbortSignal, init: RequestInit = {}): Promise<unknown> {
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) controller.abort();
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 15_000);
    try {
      const response = await fetcher(endpoint + path, { ...init, signal: controller.signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` } });
      if (response.status === 204 && response.ok) return undefined;
      const body: unknown = await response.json().catch(() => { if (response.ok) return invalidResponse(); return {}; });
      if (!response.ok) {
        const data = body && typeof body === "object" ? body as Record<string, unknown> : {};
        const detail = data.error && typeof data.error === "object" ? data.error as Record<string, unknown> : data;
        throw new DriverRouteError(typeof detail.message === "string" ? detail.message : `Ошибка ${response.status}`, response.status,
          typeof detail.code === "string" ? detail.code : undefined);
      }
      return body;
    } catch (error) {
      if (signal.aborted) throw new DriverRouteError("Обновление отменено.", undefined, "REQUEST_ABORTED");
      if (error instanceof DriverRouteError) throw error;
      throw new DriverRouteError(timedOut ? "Сервер Onay не ответил вовремя. Повтори обновление." : "Нет связи с Onay. Проверь интернет и обнови маршруты.", undefined,
        timedOut ? "REQUEST_TIMEOUT" : "NETWORK_ERROR");
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  }
  return {
    async load(signal: AbortSignal) {
      const [catalog, snapshot] = await Promise.all([
        send("/api/driver/routes", signal), send("/api/driver/route", signal),
      ]);
      return { routes: parseDriverRouteCatalog(catalog), snapshot: parseDriverRouteSnapshot(snapshot) };
    },
    async save(draft: DriverRouteChoice | null, routes: DriverRouteOption[], signal: AbortSignal) {
      const body = driverRouteSaveInput(draft, routes);
      const snapshot = parseDriverRouteSnapshot(await send("/api/driver/route", signal, { method: "PUT", body: JSON.stringify(body) }));
      if (!snapshot.choice || snapshot.choice.routeId !== body.route_id || snapshot.choice.direction !== body.direction ||
          snapshot.choice.routeUpdatedAt !== body.expected_updated_at) return invalidResponse();
      return snapshot;
    },
    async clear(signal: AbortSignal) { await send("/api/driver/route", signal, { method: "DELETE" }); },
  };
}
