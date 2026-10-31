import { AdminApiError, adminRequest } from "./api.ts";

export type OfferTimeoutPolicy = { seconds: number; revision: string | null; updatedAt: string | null };

export function readOfferTimeoutDraft(value: string): number {
  if (!/^\d+$/.test(value.trim())) throw new Error("Введите целое число секунд от 1 до 3600.");
  const seconds = Number(value.trim());
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 3600) throw new Error("Допустимо от 1 до 3600 секунд.");
  return seconds;
}

function readPolicy(value: unknown): OfferTimeoutPolicy {
  const raw = value as Record<string, unknown> | null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || typeof raw.seconds !== "number" ||
      !Number.isSafeInteger(raw.seconds) || raw.seconds < 1 || raw.seconds > 3600 ||
      (raw.revision === null ? raw.updatedAt !== null : typeof raw.revision !== "string" || !raw.revision.trim() ||
        typeof raw.updatedAt !== "string" || !Number.isFinite(Date.parse(raw.updatedAt)))) {
    throw new AdminApiError(502, "Не удалось подтвердить настройку тайм-аута.");
  }
  return { seconds: raw.seconds, revision: raw.revision as string | null, updatedAt: raw.updatedAt as string | null };
}

export async function loadOfferTimeout(token: string, signal?: AbortSignal): Promise<OfferTimeoutPolicy> {
  const result = await adminRequest<{ offer_timeout: unknown }>("/admin/settings/offer-timeout", { token, signal });
  return readPolicy(result?.offer_timeout);
}

export async function saveOfferTimeout(token: string, seconds: number, revision: string | null, signal?: AbortSignal): Promise<OfferTimeoutPolicy> {
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 3600) throw new AdminApiError(400, "Допустимо от 1 до 3600 секунд.");
  const result = await adminRequest<{ offer_timeout: unknown }>("/admin/settings/offer-timeout", {
    token, signal, method: "PUT", body: { seconds, expected_revision: revision },
  });
  const value = readPolicy(result?.offer_timeout);
  if (value.seconds !== seconds || value.revision === null) throw new AdminApiError(502, "Сервер не подтвердил сохранение настройки.");
  return value;
}
