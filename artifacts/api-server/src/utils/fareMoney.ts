import type { FareQuote, RouteDefinition } from "../types/domain";
import { AppError } from "./errors";
import { routePricePerStop } from "./routePricing";

const validAmount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Add neutral aliases to a frozen KZT quote; never convert or reprice it. */
export function withCanonicalKztFare<T extends FareQuote>(fare: T): T & { total: number; pricePerStop: number } {
  if (fare.currency !== "KZT" || !validAmount(fare.totalKzt) || !validAmount(fare.pricePerStopKzt) ||
      (fare.total !== undefined && fare.total !== fare.totalKzt) ||
      (fare.pricePerStop !== undefined && fare.pricePerStop !== fare.pricePerStopKzt)) {
    throw new AppError(422, "Fare pricing is invalid", "INVALID_FARE");
  }
  return { ...fare, total: fare.totalKzt, pricePerStop: fare.pricePerStopKzt };
}

/** Historical KZT is enriched; explicit UZS must never carry KZT-labelled sums. */
export function withCanonicalFare<T extends FareQuote>(fare: T): T & { total: number; pricePerStop: number } {
  if (fare.currency === "KZT") return withCanonicalKztFare(fare);
  if (fare.currency !== "UZS" || !validAmount(fare.total) || !validAmount(fare.pricePerStop) ||
      fare.totalKzt !== undefined || fare.pricePerStopKzt !== undefined) throw new AppError(422, "Fare pricing is invalid", "INVALID_FARE");
  return { ...fare, total: fare.total, pricePerStop: fare.pricePerStop };
}

/** A tariff is explicitly priced in its route's currency, never converted. */
export function fareMoneyFields(route: RouteDefinition, total: number) {
  const pricePerStop = routePricePerStop(route);
  if (!validAmount(total)) throw new AppError(422, "Fare exceeds supported limits", "INVALID_FARE");
  return route.currency === "KZT"
    ? { currency: route.currency, total, pricePerStop, totalKzt: total, pricePerStopKzt: pricePerStop }
    : { currency: route.currency, total, pricePerStop };
}
