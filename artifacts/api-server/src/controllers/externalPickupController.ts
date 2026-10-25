import type { Request, Response } from "express";
import { store } from "../store";
import type { Coordinates } from "../types/domain";
import { AppError } from "../utils/errors";
import { isValidCoordinates } from "../utils/geo";
import { boundedInteger, optionalString, requiredString } from "../utils/validation";
import { readDriverRouteChoiceInput } from "../utils/driverRoute";
import { validateExternalPickupSelectionInput } from "../store/externalPickup";
import { quoteExternalPickup } from "../services/externalPickupService";
import { createExternalPickupQuoteToken, verifyExternalPickupQuoteToken } from "../services/externalPickupQuoteToken";
import { publishOrderOfferChanges } from "../services/orderDispatchService";
import { serializeOrder } from "../utils/serialize";

function fields(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some(key => !allowed.includes(key))) {
    throw new AppError(400, "Unsupported external pickup fields", "VALIDATION_ERROR");
  }
  return value as Record<string, unknown>;
}

function passenger(request: Request) {
  if (!request.auth || request.auth.role !== "passenger") {
    throw new AppError(403, "Passenger mode is required", "PASSENGER_ONLY");
  }
  return request.auth;
}

/** A map/address target is not the requesting device's GPS sample. */
function target(value: unknown): Coordinates {
  const location = fields(value, ["lat", "lng"]);
  if (typeof location.lat !== "number" || typeof location.lng !== "number") {
    throw new AppError(422, "Numeric pickup coordinates are required", "INVALID_COORDINATES");
  }
  const result = { lat: location.lat, lng: location.lng, timestamp: Date.now() };
  if (!isValidCoordinates(result)) throw new AppError(422, "Invalid pickup coordinates", "INVALID_COORDINATES");
  return result;
}

export async function createExternalPickupQuote(request: Request, response: Response): Promise<void> {
  const actor = passenger(request);
  const body = fields(request.body, ["order_id", "route_id", "direction", "expected_updated_at", "destination_stop_id", "pickup_location", "pickup_address", "seats"]);
  let input;
  if (body.order_id !== undefined) {
    fields(body, ["order_id"]);
    input = { orderId: requiredString(body.order_id, "order_id", 80) };
  } else {
    if (body.seats !== undefined && typeof body.seats !== "number") {
      throw new AppError(400, "seats must be a number", "VALIDATION_ERROR");
    }
    input = {
      selection: validateExternalPickupSelectionInput({
        ...readDriverRouteChoiceInput({ route_id: body.route_id, direction: body.direction, expected_updated_at: body.expected_updated_at }),
        destinationStopId: optionalString(body.destination_stop_id, "destination_stop_id", 80),
      }),
      pickupLocation: target(body.pickup_location),
      pickupAddress: optionalString(body.pickup_address, "pickup_address", 500),
      seats: boundedInteger(body.seats === undefined ? 1 : body.seats, "seats", 1, 8),
    };
  }
  const quote = await quoteExternalPickup(actor.userId, actor.user.sessionVersion, input);
  response.json({
    quote_token: createExternalPickupQuoteToken(quote),
    quote: {
      quote_id: quote.quoteId, order_id: quote.orderId ?? quote.quoteId, driver_id: quote.driverId,
      currency: "KZT", base_fare_kzt: quote.baseFareKzt,
      pickup_surcharge_kzt: quote.pickupSurchargeKzt, total_kzt: quote.totalKzt, total: quote.totalKzt,
      road_distance_meters: quote.roadDistanceMeters, road_duration_seconds: quote.roadDurationSeconds,
      price_per_km_kzt: quote.settings.pricePerKmKzt, fare_rounding: quote.settings.fareRounding,
      expires_at: quote.expiresAt,
    },
  });
}

export async function confirmExternalPickup(request: Request, response: Response): Promise<void> {
  const actor = passenger(request);
  const body = fields(request.body, ["quote_token"]);
  const quote = verifyExternalPickupQuoteToken(requiredString(body.quote_token, "quote_token", 12 * 1024));
  const result = await store.confirmExternalPickupQuote(quote, actor.userId, actor.user.sessionVersion);
  if (result.changed) await publishOrderOfferChanges(request.app.locals.io, [{ order: result.order }]);
  response.status(result.created ? 201 : 200).json({
    order: serializeOrder(result.order), created: result.created, changed: result.changed,
  });
}
