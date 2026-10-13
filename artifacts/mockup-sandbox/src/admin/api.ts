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
  driver_approval_status?: "pending" | "approved" | "rejected";
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
  ) {
    super(message);
    this.name = "AdminApiError";
  }
}

type Options = {
  method?: "GET" | "POST";
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
    const error = payload as { error?: { message?: string } } | null;
    throw new AdminApiError(
      response.status,
      error?.error?.message || "Сервер вернул ошибку " + response.status,
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

export async function loadDirectories(token: string, signal?: AbortSignal): Promise<{
  passengers: AdminRecord[];
  drivers: AdminRecord[];
}> {
  const [p, d] = await Promise.all([
    adminRequest<{ passengers: AdminRecord[] }>("/admin/passengers", { token, signal }),
    adminRequest<{ drivers: AdminRecord[] }>("/admin/drivers", { token, signal }),
  ]);
  if (!Array.isArray(p.passengers) || !Array.isArray(d.drivers)) {
    throw new AdminApiError(502, "Некорректный ответ каталога пользователей.");
  }
  return { passengers: p.passengers, drivers: d.drivers };
}

export async function closeAdminSession(token: string): Promise<void> {
  await adminRequest<void>("/auth/logout", { token, method: "POST" });
}
