import type { OfferTimeoutPolicy } from "../types/domain";
import { OFFER_TIMEOUT_MS } from "./config";
import { AppError } from "./errors";

export const OFFER_TIMEOUT_KEY = "offer-timeout";

export function validateOfferTimeoutChange(seconds: unknown, revision: unknown): void {
  if (typeof seconds !== "number" || !Number.isSafeInteger(seconds) || seconds < 1 || seconds > 3600 ||
      (revision !== null && (typeof revision !== "string" || !revision.trim() || revision.length > 80))) {
    throw new AppError(400, "An integer timeout from 1 to 3600 and explicit revision are required", "VALIDATION_ERROR");
  }
}

/** NULL is an unconfigured row, not a cached copy of one process's environment. */
export function offerTimeoutPolicy(row?: { seconds: number | null; revision: string | null; updatedAt: string | null }): OfferTimeoutPolicy {
  if (!row || (row.seconds === null && row.revision === null && row.updatedAt === null)) {
    return { seconds: OFFER_TIMEOUT_MS / 1000, revision: null, updatedAt: null };
  }
  if (!Number.isSafeInteger(row.seconds) || row.seconds! < 1 || row.seconds! > 3600 ||
      typeof row.revision !== "string" || !row.revision || typeof row.updatedAt !== "string" || !Number.isFinite(Date.parse(row.updatedAt))) {
    throw new AppError(500, "Invalid stored offer timeout", "INTERNAL_SERVER_ERROR");
  }
  return { seconds: row.seconds!, revision: row.revision, updatedAt: row.updatedAt };
}
