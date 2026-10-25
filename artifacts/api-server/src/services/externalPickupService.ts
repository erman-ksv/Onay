import { randomUUID } from "node:crypto";
import { store } from "../store";
import type { Coordinates, ExternalPickupQuote, ExternalPickupSelectionInput, Order } from "../types/domain";
import { buildExternalPickupDetails, driverLocationFingerprint, eligibleExternalCandidate, externalPickupLeaseMs, externalPickupSurcharge, normalizeExternalPickupSettings } from "../store/externalPickup";
import { AppError } from "../utils/errors";
import { routePickupCandidates } from "./externalPickupRouting";
import { withCanonicalFare } from "../utils/fareMoney";

export interface ExternalPickupRequest {
  selection: ExternalPickupSelectionInput;
  pickupLocation: Coordinates;
  seats: number;
  pickupAddress?: string;
}

/** A quotation reserves no seats; every condition is checked again at confirmation. */
export async function quoteExternalPickup(
  passengerId: string,
  sessionVersion: number,
  request: ExternalPickupRequest | { orderId: string },
): Promise<ExternalPickupQuote> {
  let existing: Order | undefined;
  let input: ExternalPickupRequest;
  if ("orderId" in request) {
    existing = await store.getOrder(request.orderId);
    if (!existing || existing.passengerId !== passengerId || !existing.externalPickup || !existing.routeContext) {
      throw new AppError(404, "External order not found", "ORDER_NOT_FOUND");
    }
    if (existing.status !== "searching" || existing.driverId || existing.offeredDriverId ||
        !existing.externalPickup.requiresPriceConfirmation) {
      throw new AppError(409, "External order is not waiting for a new price", "EXTERNAL_ORDER_NOT_AVAILABLE");
    }
    input = {
      selection: {
        routeId: existing.routeContext.routeId,
        direction: existing.routeContext.direction,
        expectedUpdatedAt: existing.routeContext.routeUpdatedAt,
        destinationStopId: existing.fare.destinationStop.id,
      },
      pickupLocation: structuredClone(existing.pickupLocation),
      seats: existing.seats,
      ...(existing.externalPickup.pickupAddress ? { pickupAddress: existing.externalPickup.pickupAddress } : {}),
    };
  } else {
    input = request;
  }
  const excluded = existing?.attemptedDriverIds ?? [];
  const { route, candidates } = await store.getExternalPickupCandidates(input.selection, input.seats, excluded);
  const details = buildExternalPickupDetails(route, input.selection, input.pickupLocation);
  const settings = normalizeExternalPickupSettings(route.externalPickup, route.currency);
  if (candidates.length === 0) throw new AppError(409, "Водителей пока нет", "NO_DRIVERS");
  const quotedAt = Date.now();
  // Road routing performs no writes and holds no database locks. A failed batch
  // cannot silently exclude nearer drivers and return a misleading quote.
  const roads = await routePickupCandidates(candidates, input.pickupLocation);
  for (const road of roads) {
    const candidate = candidates.find(entry => entry.driverId === road.driverId)!;
    if (!eligibleExternalCandidate(candidate, route, input.selection, input.seats, excluded, Date.now())) continue;
    const roadDurationSeconds = Math.ceil(road.durationSeconds);
    try {
      externalPickupLeaseMs(roadDurationSeconds, settings);
    } catch (error) {
      if (error instanceof AppError && error.code === "PICKUP_TOO_FAR") continue;
      throw error;
    }
    const roadDistanceMeters = Math.ceil(road.distanceMeters);
    const pickupSurcharge = externalPickupSurcharge(roadDistanceMeters, settings);
    const baseFare = withCanonicalFare(details.fare).total;
    const total = baseFare + pickupSurcharge;
    if (!Number.isSafeInteger(total)) throw new AppError(422, "External fare exceeds supported limits", "INVALID_EXTERNAL_PRICE");
    const expiresAt = quotedAt + settings.quoteTtlSeconds * 1000;
    if (expiresAt <= Date.now()) throw new AppError(409, "Pickup quotation expired; request another", "QUOTE_EXPIRED");
    return {
      version: route.currency === "KZT" ? 1 : 2, quoteId: randomUUID(), passengerId, sessionVersion,
      selection: { ...input.selection, destinationStopId: details.fare.destinationStop.id },
      pickupLocation: structuredClone(input.pickupLocation), seats: input.seats,
      driverId: candidate.driverId, driverEnrollmentId: candidate.collectionState!.enrollmentId,
      driverLocationFingerprint: driverLocationFingerprint(candidate),
      roadDistanceMeters, roadDurationSeconds,
      ...(route.currency === "KZT" ? { baseFareKzt: baseFare, pickupSurchargeKzt: pickupSurcharge, totalKzt: total }
        : { currency: "UZS" as const, baseFare, pickupSurcharge, total }),
      settings: structuredClone(settings), quotedAt, expiresAt,
      ...(input.pickupAddress ? { pickupAddress: input.pickupAddress } : {}),
      ...(existing ? {
        orderId: existing.id, expectedOrderUpdatedAt: existing.updatedAt,
        expectedAttemptedDriverIds: [...(existing.attemptedDriverIds ?? [])],
      } : {}),
    };
  }
  throw new AppError(409, "No reachable driver can complete this pickup within its configured waiting period", "NO_DRIVERS");
}
