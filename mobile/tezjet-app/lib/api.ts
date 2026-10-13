export class ApiError extends Error {
  readonly status?: number;
  readonly code?: string;

  constructor(message: string, status?: number, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export function validateApiEndpoint(value: string): string {
  const candidate = value.trim();
  const rootUrl = /^https?:\/\/([^/?#\\\s]+)\/?$/i.exec(candidate);
  if (!rootUrl || rootUrl[1].includes("@")) {
    throw new ApiError("Укажи корневой адрес API без пути, параметров и данных входа.", undefined, "INVALID_API_ENDPOINT");
  }

  let endpoint: URL;
  try {
    endpoint = new URL(candidate);
  } catch {
    throw new ApiError("Адрес API некорректен. Проверь название сервера и порт.", undefined, "INVALID_API_ENDPOINT");
  }

  if (endpoint.protocol === "http:" && !/^(localhost|127\.0\.0\.1|10\.0\.2\.2|\[::1\])(?::\d+)?$/i.test(rootUrl[1])) {
    throw new ApiError("Для удалённого API нужен HTTPS. HTTP доступен только для локальной разработки.", undefined, "INVALID_API_ENDPOINT");
  }
  return endpoint.origin;
}

function configuredEndpoint(): string {
  try {
    return validateApiEndpoint(process.env.EXPO_PUBLIC_API_URL || "");
  } catch {
    return "";
  }
}

export let API = configuredEndpoint();

export function setApiEndpoint(value: string): string {
  const endpoint = validateApiEndpoint(value);
  API = endpoint;
  return endpoint;
}

export type Availability = { available: boolean; eligible_driver_count: number; offer_timeout_seconds: number };

export async function request<T>(path: string, token?: string, init: RequestInit = {}): Promise<T> {
  if (!API) throw new ApiError("Укажи адрес сервера TezJet в настройках подключения.", undefined, "API_NOT_CONFIGURED");
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 15_000);
  try {
    const response = await fetch(API + path, {
      ...init,
      signal: controller.signal,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
    if (response.ok && response.status === 204) return undefined as T;
    const data = await response.json().catch(() => {
      if (response.ok) throw new ApiError("TezJet вернул некорректный ответ. Повтори обновление.", response.status, "INVALID_RESPONSE");
      return {};
    });
    if (!response.ok) {
      const body = data && typeof data === "object" ? data : {};
      const detail = typeof body.message === "string" ? body.message
        : typeof body.error === "string" ? body.error
        : typeof body.error?.message === "string" ? body.error.message
        : `Ошибка ${response.status}`;
      const code = typeof body.error?.code === "string" ? body.error.code
        : typeof body.code === "string" ? body.code : undefined;
      throw new ApiError(detail, response.status, code);
    }
    return data as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (timedOut) throw new ApiError("Сервер TezJet не ответил вовремя. Повтори попытку.", undefined, "REQUEST_TIMEOUT");
    throw new ApiError("Нет связи с TezJet. Проверь интернет и повтори попытку.", undefined, "NETWORK_ERROR");
  } finally {
    clearTimeout(timer);
  }
}

export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
