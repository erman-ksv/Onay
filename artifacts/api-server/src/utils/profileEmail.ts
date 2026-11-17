import { AppError } from "./errors";

/** Optional contact; it is never an authentication identifier. */
export function normalizeProfileEmail(value: unknown): string | null {
  if (value === null || value === "") return null;
  if (typeof value !== "string") throw new AppError(400, "Неверный формат email", "INVALID_EMAIL");
  const email = value.trim();
  if (!email) return null;
  if (email.length > 254 || !/^[^\s@]{1,64}@[^\s@.]+(?:\.[^\s@.]+)+$/.test(email)) {
    throw new AppError(400, "Проверь формат email", "INVALID_EMAIL");
  }
  return email.toLowerCase();
}
