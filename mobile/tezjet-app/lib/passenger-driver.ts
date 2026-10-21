export type PassengerDriver = { id: string; fullName: string; phoneNumber: string };
const contactStatuses = new Set(["en_route_to_c", "arrived_at_c", "boarded_waiting", "in_transit"]);

export function canReadDriverContact(order: { status: string; driver_id?: string }): boolean {
  return contactStatuses.has(order.status) && typeof order.driver_id === "string" && !!order.driver_id.trim();
}

/** Pick only the public contact contract; never retain a complete user object. */
export function parsePassengerDriver(value: unknown, expectedDriverId: string): PassengerDriver {
  const invalid = () => new Error("Не удалось подтвердить данные водителя. Повтори обновление.");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const raw = (value as Record<string, unknown>).driver;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw invalid();
  const driver = raw as Record<string, unknown>;
  if (!expectedDriverId || driver.id !== expectedDriverId || typeof driver.full_name !== "string" ||
      driver.full_name.trim().length > 200 || typeof driver.phone_number !== "string" ||
      !/^\+[1-9]\d{7,14}$/.test(driver.phone_number)) throw invalid();
  return { id: expectedDriverId, fullName: driver.full_name.trim(), phoneNumber: driver.phone_number };
}

/** Capture the selected endpoint and session before asynchronous work. */
export function createPassengerDriverClient(endpoint: string, token: string, fetcher: typeof fetch = fetch) {
  const url = new URL(endpoint);
  const local = ["localhost", "127.0.0.1", "10.0.2.2", "[::1]"].includes(url.hostname);
  if (!token.trim() || url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && local))) {
    throw new Error("Проверь адрес сервера и войди в Onay ещё раз.");
  }
  return async (orderId: string, driverId: string, signal: AbortSignal): Promise<PassengerDriver> => {
    if (!orderId || !driverId) throw new Error("Водитель ещё не назначен.");
    const response = await fetcher(`${url.origin}/api/orders/${encodeURIComponent(orderId)}/driver`, {
      method: "GET", headers: { Accept: "application/json", Authorization: `Bearer ${token}` }, signal, cache: "no-store",
    });
    if (!response.ok) {
      throw new Error(response.status === 404 ? "Контакт водителя сейчас недоступен. Обнови поездку."
        : response.status === 401 || response.status === 403 ? "Не удалось подтвердить доступ. Обнови поездку или войди ещё раз."
        : "Не удалось получить контакт водителя. Повтори обновление.");
    }
    try { return parsePassengerDriver(await response.json(), driverId); }
    catch { throw new Error("Не удалось подтвердить данные водителя. Повтори обновление."); }
  };
}

/** Cancelling or replacing a request also invalidates a fetch ignoring abort. */
export function createPassengerDriverScope() {
  let generation = 0;
  let controller: AbortController | null = null;
  return {
    start() { controller?.abort(); controller = new AbortController(); return { generation: ++generation, signal: controller.signal }; },
    isCurrent(ticket: { generation: number; signal: AbortSignal }) { return generation === ticket.generation && !ticket.signal.aborted; },
    cancel() { generation += 1; controller?.abort(); controller = null; },
  };
}
