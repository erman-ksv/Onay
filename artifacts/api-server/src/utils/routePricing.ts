import type { FareCurrency, RouteDefinition } from "../types/domain";
import type { RouteMetadataPatch } from "../store/storeContract";
import { AppError } from "./errors";

export type RoutePricing = { currency: FareCurrency; pricePerStop?: number; pricePerStopKzt?: number };
const valid = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000;

/** Preserve legacy KZT route JSON; UZS must have an explicit neutral tariff. */
export function normalizeRoutePricing(input: Partial<RoutePricing>): RoutePricing {
  const currency = input.currency ?? "KZT";
  if (currency !== "KZT" && currency !== "UZS") throw new AppError(400, "Unsupported route currency", "INVALID_CURRENCY");
  if (currency === "UZS") {
    if (!valid(input.pricePerStop) || input.pricePerStopKzt !== undefined) throw new AppError(400, "UZS requires an explicit neutral tariff", "INVALID_ROUTE_PRICE");
    return { currency, pricePerStop: input.pricePerStop };
  }
  const price = input.pricePerStopKzt ?? input.pricePerStop;
  if (!valid(price) || (input.pricePerStop !== undefined && input.pricePerStop !== price) ||
      (input.pricePerStopKzt !== undefined && input.pricePerStopKzt !== price)) throw new AppError(400, "Route tariff is invalid or contradictory", "INVALID_ROUTE_PRICE");
  return { currency, pricePerStopKzt: price };
}

export function routePricePerStop(route: RoutePricing): number {
  const pricing = normalizeRoutePricing(route);
  return (pricing.currency === "KZT" ? pricing.pricePerStopKzt : pricing.pricePerStop)!;
}

/** Currency is immutable: use a new route instead of relabelling old amounts. */
export function applyRoutePricingPatch(route: RouteDefinition, patch: RouteMetadataPatch): RouteDefinition {
  if (patch.currency !== undefined && patch.currency !== route.currency) throw new AppError(409, "Route currency cannot be changed; create a new route", "ROUTE_CURRENCY_IMMUTABLE");
  if (patch.pricePerStop === undefined && patch.pricePerStopKzt === undefined) return { ...route, ...patch };
  const pricing = normalizeRoutePricing({ currency: route.currency, pricePerStop: patch.pricePerStop, pricePerStopKzt: patch.pricePerStopKzt });
  const { pricePerStop: _neutral, pricePerStopKzt: _legacy, ...rest } = route;
  const { pricePerStop: _newNeutral, pricePerStopKzt: _newLegacy, currency: _currency, ...metadata } = patch;
  return { ...rest, ...metadata, ...pricing };
}
