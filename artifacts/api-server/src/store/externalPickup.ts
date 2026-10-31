import { createHmac } from "node:crypto";
import type {
  Coordinates, ExternalPickupQuote, ExternalPickupSelectionInput, ExternalPickupSettings,
  Order, QueueEntry, RouteDefinition, FareCurrency,
} from "../types/domain";
import { AppError } from "../utils/errors";
import { isValidCoordinates, isWithinRadius } from "../utils/geo";
import { buildRouteOrder } from "../utils/routeOrder";
import { validateDriverRouteChoiceInput } from "../utils/driverRoute";
import { optionalString, requiredString } from "../utils/validation";
import { JWT_SECRET, OFFER_TIMEOUT_MS } from "../utils/config";
import { isCollecting } from "./lineCollection";
import { withCanonicalFare } from "../utils/fareMoney";
import { externalQuoteAmounts } from "../utils/externalMoney";

type ExternalDetails = Pick<Order, "pickupPoint" | "routeContext" | "routeStops" | "fare" | "destination">;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const settingsCommonKeys = ["enabled", "serviceRadiusMeters", "gpsMaxAgeSeconds", "quoteTtlSeconds", "pickupGraceSeconds", "maxPickupSeconds", "fareRounding"] as const;
const settingsKeys = [...settingsCommonKeys, "currency", "pricePerKm", "pricePerKmKzt"] as const;
const locationFingerprintKey = createHmac("sha256", JWT_SECRET)
  .update("TezJet/external-pickup-driver-location/v1").digest();

function record(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) {
    throw new AppError(400, "External pickup fields are invalid", "VALIDATION_ERROR");
  }
  return value as Record<string, unknown>;
}

function integer(value: unknown, minimum: number, maximum: number, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new AppError(400, `${field} must be an integer between ${minimum} and ${maximum}`, "VALIDATION_ERROR");
  }
  return value;
}

/** No settings or tariff defaults: the administrator must supply every field. */
export function normalizeExternalPickupSettings(input: unknown, expectedCurrency?: FareCurrency): ExternalPickupSettings {
  const fields = record(input, settingsKeys);
  const currency = fields.currency ?? "KZT";
  if ((currency !== "KZT" && currency !== "UZS") || (expectedCurrency !== undefined && currency !== expectedCurrency) ||
      settingsCommonKeys.some(key => !Object.hasOwn(fields, key)) || typeof fields.enabled !== "boolean") {
    throw new AppError(400, "All external pickup settings and matching currency are required", "VALIDATION_ERROR");
  }
  let pricing: Pick<ExternalPickupSettings, "currency" | "pricePerKm" | "pricePerKmKzt" | "fareRounding">;
  if (currency === "UZS") {
    if (Object.hasOwn(fields, "pricePerKmKzt") || (fields.fareRounding !== "ceil" && fields.fareRounding !== "nearest")) {
      throw new AppError(400, "UZS pickup requires neutral pricing and rounding", "VALIDATION_ERROR");
    }
    pricing = { currency, pricePerKm: integer(fields.pricePerKm, 0, 1_000_000_000, "price_per_km"), fareRounding: fields.fareRounding };
  } else {
    const rate = integer(fields.pricePerKmKzt ?? fields.pricePerKm, 0, 1_000_000_000, "price_per_km_kzt");
    if ((fields.pricePerKm !== undefined && fields.pricePerKm !== rate) ||
        (fields.pricePerKmKzt !== undefined && fields.pricePerKmKzt !== rate) ||
        (fields.fareRounding !== "ceil_kzt" && fields.fareRounding !== "nearest_kzt")) {
      throw new AppError(400, "KZT pickup pricing or rounding is invalid", "VALIDATION_ERROR");
    }
    // Keep the v1 policy byte shape: old signed quotes compare this snapshot.
    pricing = { pricePerKmKzt: rate, fareRounding: fields.fareRounding };
  }
  const settings: ExternalPickupSettings = {
    enabled: fields.enabled,
    serviceRadiusMeters: integer(fields.serviceRadiusMeters, 1, 500_000, "service_radius_meters"),
    ...pricing,
    gpsMaxAgeSeconds: integer(fields.gpsMaxAgeSeconds, 1, 3600, "gps_max_age_seconds"),
    quoteTtlSeconds: integer(fields.quoteTtlSeconds, 1, 3600, "quote_ttl_seconds"),
    pickupGraceSeconds: integer(fields.pickupGraceSeconds, 0, 86400, "pickup_grace_seconds"),
    maxPickupSeconds: integer(fields.maxPickupSeconds, 1, 86400, "max_pickup_seconds"),
  };
  if (settings.pickupGraceSeconds > settings.maxPickupSeconds) {
    throw new AppError(400, "Pickup grace cannot exceed the maximum pickup time", "VALIDATION_ERROR");
  }
  return settings;
}

export function validateExternalPickupSelectionInput(input: unknown): ExternalPickupSelectionInput {
  const fields = record(input, ["routeId", "direction", "expectedUpdatedAt", "destinationStopId"]);
  const choice = validateDriverRouteChoiceInput(fields as unknown as ExternalPickupSelectionInput);
  const destinationStopId = optionalString(fields.destinationStopId, "destination_stop_id", 80);
  return { ...choice, ...(destinationStopId === undefined ? {} : { destinationStopId }) };
}

export function externalPickupSurcharge(distanceMeters: number, settings: ExternalPickupSettings): number {
  const distance = integer(distanceMeters, 0, 10_000_000, "road_distance_meters");
  const uzs = settings.currency === "UZS";
  const rate = integer(uzs ? settings.pricePerKm : settings.pricePerKmKzt, 0, 1_000_000_000, uzs ? "price_per_km" : "price_per_km_kzt");
  const validRounding = uzs ? settings.fareRounding === "ceil" || settings.fareRounding === "nearest"
    : settings.fareRounding === "ceil_kzt" || settings.fareRounding === "nearest_kzt";
  const validCurrency = uzs ? settings.pricePerKmKzt === undefined : settings.currency === undefined || settings.currency === "KZT";
  if (!validRounding || !validCurrency) {
    throw new AppError(400, "A matching pickup currency and rounding are required", "VALIDATION_ERROR");
  }
  // Integer metre billing preserves exact boundaries in either currency.
  const numerator = BigInt(distance) * BigInt(rate);
  const rounded = (numerator + (settings.fareRounding === "ceil_kzt" || settings.fareRounding === "ceil" ? 999n : 500n)) / 1000n;
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new AppError(422, "Pickup fare exceeds the supported amount", "INVALID_PICKUP_FARE");
  }
  return Number(rounded);
}

/** Compatibility API: the KZT-named helper never computes UZS. */
export function externalPickupSurchargeKzt(distanceMeters: number, settings: ExternalPickupSettings): number {
  if (settings.currency === "UZS") throw new AppError(400, "KZT helper cannot compute UZS", "VALIDATION_ERROR");
  return externalPickupSurcharge(distanceMeters, settings);
}

export function externalPickupLeaseMs(roadDurationSeconds: number, settings: ExternalPickupSettings): number {
  const seconds = integer(roadDurationSeconds, 0, 1_000_000, "road_duration_seconds") + settings.pickupGraceSeconds;
  if (!Number.isSafeInteger(seconds) || seconds > settings.maxPickupSeconds) {
    throw new AppError(422, "Pickup travel time exceeds the configured maximum", "PICKUP_TOO_FAR");
  }
  // A zero-distance pickup still has the administrator's explicit grace policy.
  return seconds * 1000;
}

function targetLocation(value: unknown): Coordinates {
  const fields = record(value, ["lat", "lng", "timestamp", "isMocked"]);
  if (typeof fields.lat !== "number" || typeof fields.lng !== "number" ||
      !isValidCoordinates(fields as unknown as Coordinates) ||
      (fields.isMocked !== undefined && typeof fields.isMocked !== "boolean") || fields.isMocked === true ||
      typeof fields.timestamp !== "number" || !Number.isFinite(fields.timestamp) || fields.timestamp < 0) {
    throw new AppError(400, "External pickup coordinates are invalid", "VALIDATION_ERROR");
  }
  return { lat: fields.lat, lng: fields.lng, timestamp: fields.timestamp,
    ...(fields.isMocked === undefined ? {} : { isMocked: false }) };
}

/** Structural validation used after the separate quote key/audience verification. */
export function validateExternalPickupQuote(value: unknown): ExternalPickupQuote {
  const version = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>).version : undefined;
  const moneyKeys = version === 2 ? ["currency", "baseFare", "pickupSurcharge", "total"] : ["baseFareKzt", "pickupSurchargeKzt", "totalKzt"];
  const fields = record(value, ["version", "quoteId", "passengerId", "sessionVersion", "selection", "pickupLocation", "seats", "driverId", "driverEnrollmentId", "driverLocationFingerprint", "roadDistanceMeters", "roadDurationSeconds", ...moneyKeys, "settings", "quotedAt", "expiresAt", "orderId", "expectedOrderUpdatedAt", "expectedAttemptedDriverIds", "pickupAddress"]);
  if ((version !== 1 && version !== 2) || (version === 2 && fields.currency !== "UZS") || typeof fields.quoteId !== "string" || !UUID.test(fields.quoteId) ||
      typeof fields.driverEnrollmentId !== "string" || !UUID.test(fields.driverEnrollmentId) ||
      typeof fields.driverLocationFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(fields.driverLocationFingerprint)) {
    throw new AppError(400, "External pickup quote is invalid", "INVALID_PICKUP_QUOTE");
  }
  const currency: FareCurrency = version === 1 ? "KZT" : "UZS";
  const settings = normalizeExternalPickupSettings(fields.settings, currency);
  const roadDistanceMeters = integer(fields.roadDistanceMeters, 0, 10_000_000, "road_distance_meters");
  const roadDurationSeconds = integer(fields.roadDurationSeconds, 0, 1_000_000, "road_duration_seconds");
  externalPickupLeaseMs(roadDurationSeconds, settings);
  const baseFare = integer(version === 1 ? fields.baseFareKzt : fields.baseFare, 0, Number.MAX_SAFE_INTEGER, "base_fare");
  const pickupSurcharge = integer(version === 1 ? fields.pickupSurchargeKzt : fields.pickupSurcharge, 0, Number.MAX_SAFE_INTEGER, "pickup_surcharge");
  const total = integer(version === 1 ? fields.totalKzt : fields.total, 0, Number.MAX_SAFE_INTEGER, "total");
  const quotedAt = integer(fields.quotedAt, 0, 8_640_000_000_000_000, "quoted_at");
  const expiresAt = integer(fields.expiresAt, 0, 8_640_000_000_000_000, "expires_at");
  if (expiresAt <= quotedAt || expiresAt - quotedAt > settings.quoteTtlSeconds * 1000 ||
      pickupSurcharge !== externalPickupSurcharge(roadDistanceMeters, settings) ||
      !Number.isSafeInteger(baseFare + pickupSurcharge) || total !== baseFare + pickupSurcharge) {
    throw new AppError(400, "External pickup quote totals or expiry are invalid", "INVALID_PICKUP_QUOTE");
  }
  const orderId = optionalString(fields.orderId, "order_id", 80);
  const expectedOrderUpdatedAt = optionalString(fields.expectedOrderUpdatedAt, "expected_order_updated_at", 80);
  let expectedAttemptedDriverIds: string[] | undefined;
  if (fields.expectedAttemptedDriverIds !== undefined) {
    if (!Array.isArray(fields.expectedAttemptedDriverIds) || fields.expectedAttemptedDriverIds.length > 1000) {
      throw new AppError(400, "External pickup quote history is invalid", "INVALID_PICKUP_QUOTE");
    }
    expectedAttemptedDriverIds = fields.expectedAttemptedDriverIds.map(id => requiredString(id, "driver_id", 120));
    if (new Set(expectedAttemptedDriverIds).size !== expectedAttemptedDriverIds.length) {
      throw new AppError(400, "External pickup quote history is invalid", "INVALID_PICKUP_QUOTE");
    }
  }
  if (orderId ? !expectedOrderUpdatedAt || !expectedAttemptedDriverIds || !Number.isFinite(Date.parse(expectedOrderUpdatedAt))
    : expectedOrderUpdatedAt !== undefined || expectedAttemptedDriverIds !== undefined) {
    throw new AppError(400, "External pickup quote revision is invalid", "INVALID_PICKUP_QUOTE");
  }
  const pickupAddress = optionalString(fields.pickupAddress, "pickup_address", 500);
  return {
    version, quoteId: fields.quoteId, passengerId: requiredString(fields.passengerId, "passenger_id", 120),
    sessionVersion: integer(fields.sessionVersion, 0, Number.MAX_SAFE_INTEGER, "session_version"),
    selection: validateExternalPickupSelectionInput(fields.selection), pickupLocation: targetLocation(fields.pickupLocation),
    seats: integer(fields.seats, 1, 8, "seats"), driverId: requiredString(fields.driverId, "driver_id", 120),
    driverEnrollmentId: fields.driverEnrollmentId, driverLocationFingerprint: fields.driverLocationFingerprint,
    roadDistanceMeters, roadDurationSeconds,
    ...(version === 1 ? { baseFareKzt: baseFare, pickupSurchargeKzt: pickupSurcharge, totalKzt: total } : { currency, baseFare, pickupSurcharge, total }),
    settings, quotedAt, expiresAt,
    ...(orderId === undefined ? {} : { orderId, expectedOrderUpdatedAt, expectedAttemptedDriverIds }),
    ...(pickupAddress === undefined ? {} : { pickupAddress }),
  };
}

export function buildExternalPickupDetails(route: RouteDefinition | undefined, selection: ExternalPickupSelectionInput, target?: Coordinates): ExternalDetails {
  const input = validateExternalPickupSelectionInput(selection);
  const details = buildRouteOrder(route, input);
  if (!route?.externalPickup || !normalizeExternalPickupSettings(route.externalPickup, route.currency).enabled) {
    throw new AppError(422, "External pickup is disabled for this route", "EXTERNAL_PICKUP_DISABLED");
  }
  if (target) {
    const location = targetLocation(target);
    if (!isWithinRadius(location, details.routeContext!.center, route.externalPickup.serviceRadiusMeters)) {
      throw new AppError(422, "Pickup is outside the administrator's service area", "OUTSIDE_PICKUP_SERVICE_AREA");
    }
  }
  return details;
}

/** A receipt heartbeat at the same position does not change the quoted location. */
export function driverLocationFingerprint(entry: QueueEntry): string {
  return createHmac("sha256", locationFingerprintKey).update(JSON.stringify([
    "external-pickup-v1", entry.collectionState?.enrollmentId, entry.lastLocation.lat, entry.lastLocation.lng,
  ])).digest("hex");
}

export function eligibleExternalCandidate(entry: QueueEntry | undefined, route: RouteDefinition | undefined, selection: ExternalPickupSelectionInput, seats: number, excludedDriverIds: readonly string[] = [], now = Date.now()): boolean {
  if (!entry || !route || !isCollecting(entry) || entry.inFifo === false || entry.pendingOfferOrderId ||
      !Number.isInteger(seats) || seats < 1 || seats > 8 || !Number.isInteger(entry.availableSeats) || entry.availableSeats < seats ||
      !entry.collectionState || entry.availableSeats > entry.collectionState.capacity || excludedDriverIds.includes(entry.driverId) ||
      !entry.routeContext || entry.routeContext.routeId !== selection.routeId || entry.routeContext.direction !== selection.direction ||
      entry.routeContext.routeUpdatedAt !== selection.expectedUpdatedAt || !isValidCoordinates(entry.lastLocation) || entry.lastLocation.isMocked === true) return false;
  try {
    buildExternalPickupDetails(route, selection);
    const settings = normalizeExternalPickupSettings(route.externalPickup, route.currency);
    const age = now - entry.collectionState.locationUpdatedAt;
    return Number.isFinite(age) && age >= 0 && age <= settings.gpsMaxAgeSeconds * 1000;
  } catch { return false; }
}

export function assertExternalQuoteCurrent(quote: ExternalPickupQuote, route: RouteDefinition | undefined, entry: QueueEntry | undefined, passengerId: string, sessionVersion: number, now = Date.now()): void {
  const verified = validateExternalPickupQuote(quote);
  if (verified.passengerId !== passengerId || verified.sessionVersion !== sessionVersion) {
    throw new AppError(401, "Session is no longer valid", "UNAUTHORIZED");
  }
  if (verified.expiresAt <= now || verified.quotedAt > now) {
    throw new AppError(409, "Pickup quote expired; request a current quote", "PICKUP_QUOTE_EXPIRED");
  }
  const details = buildExternalPickupDetails(route, verified.selection, verified.pickupLocation);
  if (!entry || entry.driverId !== verified.driverId || !eligibleExternalCandidate(entry, route, verified.selection, verified.seats, verified.expectedAttemptedDriverIds, now) ||
      entry.collectionState?.enrollmentId !== verified.driverEnrollmentId || driverLocationFingerprint(entry) !== verified.driverLocationFingerprint ||
      JSON.stringify(normalizeExternalPickupSettings(route!.externalPickup, route!.currency)) !== JSON.stringify(verified.settings) ||
      details.fare.currency !== externalQuoteAmounts(verified).currency || withCanonicalFare(details.fare).total !== externalQuoteAmounts(verified).baseFare) {
    throw new AppError(409, "Driver or pickup price changed; request a current quote", "PICKUP_QUOTE_CHANGED");
  }
}

export function nextOrderUpdatedAt(previous: string, now = Date.now()): string {
  const parsed = Date.parse(previous);
  return new Date(Math.max(now, Number.isFinite(parsed) ? parsed + 1 : 0)).toISOString();
}

function assertRequote(quote: ExternalPickupQuote, existing: Order, passengerId: string): void {
  if (existing.passengerId !== passengerId || existing.id !== quote.orderId) {
    throw new AppError(404, "Order was not found", "ORDER_NOT_FOUND");
  }
  if (existing.externalPickup && (externalQuoteAmounts(quote).currency !== existing.fare.currency || quote.version !== existing.externalPickup.version)) {
    throw new AppError(409, "Pickup currency changed; create a new order", "PICKUP_QUOTE_CHANGED");
  }
  if (!existing.externalPickup || existing.status !== "searching" || existing.driverId || existing.offeredDriverId ||
      existing.offerExpiresAt !== undefined || !existing.externalPickup.requiresPriceConfirmation) {
    throw new AppError(409, "This order is not awaiting a new pickup price", "PICKUP_REQUOTE_NOT_AVAILABLE");
  }
  if (existing.updatedAt !== quote.expectedOrderUpdatedAt ||
      JSON.stringify([...(existing.attemptedDriverIds ?? [])].sort()) !== JSON.stringify([...(quote.expectedAttemptedDriverIds ?? [])].sort())) {
    throw new AppError(409, "Order changed; request a current pickup quote", "PICKUP_QUOTE_CHANGED");
  }
  if (!existing.routeContext || existing.routeContext.routeId !== quote.selection.routeId || existing.routeContext.direction !== quote.selection.direction ||
      existing.routeContext.routeUpdatedAt !== quote.selection.expectedUpdatedAt) {
    throw new AppError(409, "Route changed; create a new order with the current catalog", "ROUTE_CHANGED");
  }
  if (existing.seats !== quote.seats || existing.pickupLocation.lat !== quote.pickupLocation.lat || existing.pickupLocation.lng !== quote.pickupLocation.lng ||
      existing.fare.destinationStop.id !== quote.selection.destinationStopId || existing.externalPickup.pickupAddress !== quote.pickupAddress) {
    throw new AppError(409, "Pickup selection changed; create a new order", "PICKUP_QUOTE_CHANGED");
  }
}

export function buildConfirmedExternalOrder(quote: ExternalPickupQuote, route: RouteDefinition, passenger: { id: string; phoneNumber: string }, existing?: Order, now = Date.now(), offerTimeoutMs = OFFER_TIMEOUT_MS): Order {
  const verified = validateExternalPickupQuote(quote);
  if (existing) assertRequote(verified, existing, passenger.id);
  else if (verified.orderId || passenger.id !== verified.passengerId) throw new AppError(409, "Pickup quote does not create this order", "PICKUP_QUOTE_CHANGED");
  const details = buildExternalPickupDetails(route, verified.selection, verified.pickupLocation);
  const money = externalQuoteAmounts(verified);
  if (details.fare.currency !== money.currency || withCanonicalFare(details.fare).total !== money.baseFare) throw new AppError(409, "Pickup fare changed", "PICKUP_QUOTE_CHANGED");
  const timestamp = new Date(now).toISOString();
  return {
    ...details, id: existing?.id ?? verified.quoteId, passengerId: passenger.id, passengerPhone: passenger.phoneNumber,
    pickupLocation: structuredClone(verified.pickupLocation), seats: verified.seats, status: "searching",
    fare: withCanonicalFare({ ...details.fare, total: money.total, ...(money.currency === "KZT" ? { totalKzt: money.total } : {}) }), driverId: undefined,
    offeredDriverId: verified.driverId, offerExpiresAt: now + offerTimeoutMs, seatLockExpiresAt: undefined,
    attemptedDriverIds: [...new Set([...(existing?.attemptedDriverIds ?? []), verified.driverId])],
    createdAt: existing?.createdAt ?? timestamp, updatedAt: existing ? nextOrderUpdatedAt(existing.updatedAt, now) : timestamp,
    externalPickup: {
      version: verified.version, quoteId: verified.quoteId, requiresPriceConfirmation: false, driverEnrollmentId: verified.driverEnrollmentId,
      driverLocationFingerprint: verified.driverLocationFingerprint, roadDistanceMeters: verified.roadDistanceMeters,
      roadDurationSeconds: verified.roadDurationSeconds,
      ...(money.currency === "KZT" ? { baseFareKzt: money.baseFare, pickupSurchargeKzt: money.pickupSurcharge }
        : { currency: money.currency, baseFare: money.baseFare, pickupSurcharge: money.pickupSurcharge }),
      settings: structuredClone(verified.settings), quotedAt: verified.quotedAt, quoteExpiresAt: verified.expiresAt,
      ...(verified.pickupAddress === undefined ? {} : { pickupAddress: verified.pickupAddress }),
    },
  };
}

export function liveExternalOfferValid(order: Order, entry: QueueEntry | undefined, route: RouteDefinition | undefined, now = Date.now()): boolean {
  const pickup = order.externalPickup;
  if (!pickup || pickup.requiresPriceConfirmation || order.status !== "searching" || order.driverId || !entry ||
      order.offeredDriverId !== entry.driverId || entry.pendingOfferOrderId !== order.id ||
      order.offerExpiresAt === undefined || order.offerExpiresAt <= now || !order.routeContext ||
      entry.collectionState?.enrollmentId !== pickup.driverEnrollmentId) return false;
  try {
    const selection = { routeId: order.routeContext.routeId, direction: order.routeContext.direction, expectedUpdatedAt: order.routeContext.routeUpdatedAt, destinationStopId: order.fare.destinationStop.id };
    buildExternalPickupDetails(route, selection, order.pickupLocation);
    // PostgreSQL JSONB may reorder keys in the persisted snapshot. Compare
    // canonical policy values, not the provider object's insertion order.
    return order.fare.currency === route!.currency &&
      JSON.stringify(normalizeExternalPickupSettings(route!.externalPickup, route!.currency)) === JSON.stringify(normalizeExternalPickupSettings(pickup.settings, route!.currency)) &&
      eligibleExternalCandidate({ ...entry, pendingOfferOrderId: undefined, availableSeats: entry.availableSeats + order.seats }, route, selection, order.seats, [], now);
  } catch { return false; }
}

/** An explicit consent boundary: keep the old agreed fare as history, reserve nobody. */
export function repriceExternalOrder(order: Order, now = Date.now()): Order {
  if (!order.externalPickup || order.status === "completed" || order.status === "cancelled") return order;
  if (order.status === "searching" && order.externalPickup.requiresPriceConfirmation && !order.driverId && !order.offeredDriverId && order.offerExpiresAt === undefined && order.seatLockExpiresAt === undefined) return order;
  return {
    ...order, status: "searching", driverId: undefined, offeredDriverId: undefined, offerExpiresAt: undefined, seatLockExpiresAt: undefined,
    attemptedDriverIds: [...new Set([...(order.attemptedDriverIds ?? []), ...[order.driverId, order.offeredDriverId].filter((id): id is string => Boolean(id))])],
    externalPickup: { ...order.externalPickup, requiresPriceConfirmation: true }, updatedAt: nextOrderUpdatedAt(order.updatedAt, now),
  };
}
