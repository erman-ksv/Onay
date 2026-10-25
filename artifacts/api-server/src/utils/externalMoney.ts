import type { ExternalPickupQuote, ExternalPickupSettings, FareCurrency, Order } from "../types/domain";
import { AppError } from "./errors";

const amount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** A v1 claim always means KZT; a v2 UZS claim never reads KZT aliases. */
export function externalQuoteAmounts(quote: ExternalPickupQuote): { currency: FareCurrency; baseFare: number; pickupSurcharge: number; total: number } {
  const legacy = quote.version === 1;
  const currency = legacy ? "KZT" : quote.currency;
  const baseFare = legacy ? quote.baseFareKzt : quote.baseFare;
  const pickupSurcharge = legacy ? quote.pickupSurchargeKzt : quote.pickupSurcharge;
  const total = legacy ? quote.totalKzt : quote.total;
  if ((legacy ? quote.currency !== undefined && quote.currency !== "KZT" : quote.version !== 2 || currency !== "UZS") ||
      !amount(baseFare) || !amount(pickupSurcharge) || !amount(total) ||
      !Number.isSafeInteger(baseFare + pickupSurcharge) || total !== baseFare + pickupSurcharge) {
    throw new AppError(400, "External pickup money is invalid", "INVALID_PICKUP_QUOTE");
  }
  return { currency: currency!, baseFare, pickupSurcharge, total };
}

/** Public route policy contains rates, never driver locations or signed claims. */
export function publicExternalSettings(settings: ExternalPickupSettings): Record<string, unknown> {
  return {
    enabled: settings.enabled, service_radius_meters: settings.serviceRadiusMeters,
    ...(settings.currency === "UZS" ? { currency: "UZS", price_per_km: settings.pricePerKm }
      : { price_per_km_kzt: settings.pricePerKmKzt }),
    fare_rounding: settings.fareRounding,
  };
}

/** Serialize only the saved agreement; never consult the current route tariff. */
export function serializeExternalPickup(order: Order): Record<string, unknown> | undefined {
  const pickup = order.externalPickup;
  if (!pickup) return undefined;
  const legacy = pickup.version === 1;
  const currency = legacy ? "KZT" : pickup.currency;
  const baseFare = legacy ? pickup.baseFareKzt : pickup.baseFare;
  const pickupSurcharge = legacy ? pickup.pickupSurchargeKzt : pickup.pickupSurcharge;
  const total = legacy ? order.fare.totalKzt : order.fare.total;
  if (currency !== order.fare.currency || !amount(baseFare) || !amount(pickupSurcharge) || !amount(total) ||
      !Number.isSafeInteger(baseFare + pickupSurcharge) || baseFare + pickupSurcharge !== total ||
      (legacy ? pickup.settings.currency === "UZS" : pickup.version !== 2 || currency !== "UZS" || pickup.settings.currency !== "UZS")) {
    throw new AppError(422, "Saved pickup money is invalid", "INVALID_FARE");
  }
  return {
    pickup_address: pickup.pickupAddress, requires_price_confirmation: pickup.requiresPriceConfirmation,
    road_distance_meters: pickup.roadDistanceMeters, road_duration_seconds: pickup.roadDurationSeconds,
    ...(legacy ? { base_fare_kzt: baseFare, pickup_surcharge_kzt: pickupSurcharge, total_kzt: total,
      price_per_km_kzt: pickup.settings.pricePerKmKzt }
      : { currency: "UZS", base_fare: baseFare, pickup_surcharge: pickupSurcharge, total,
        price_per_km: pickup.settings.pricePerKm }),
    fare_rounding: pickup.settings.fareRounding,
  };
}
