import type { FareQuote } from "../types/domain";
import { AppError } from "./errors";

/** Add neutral aliases to a frozen KZT quote; never convert or reprice it. */
export function withCanonicalKztFare<T extends FareQuote>(fare: T): T & { total: number; pricePerStop: number } {
  const validAmount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  if (fare.currency !== "KZT" || !validAmount(fare.totalKzt) || !validAmount(fare.pricePerStopKzt) ||
      (fare.total !== undefined && fare.total !== fare.totalKzt) ||
      (fare.pricePerStop !== undefined && fare.pricePerStop !== fare.pricePerStopKzt)) {
    throw new AppError(422, "Fare pricing is invalid", "INVALID_FARE");
  }
  return { ...fare, total: fare.totalKzt, pricePerStop: fare.pricePerStopKzt };
}
