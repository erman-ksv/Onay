import { createHash } from "node:crypto";
import type { RouteOrderSelectionInput } from "../store/storeContract";
import { AppError } from "./errors";
import { validateRouteOrderSelectionInput } from "./routeOrder";
import { boundedInteger } from "./validation";

export const MAX_CLOSED_ROUTE_REQUESTS_PER_DAY = 64;
export const ROUTE_REQUEST_CLOSURE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** One client-generated UUID identifies one booking intent for one passenger. */
export function requireRouteOrderRequestKey(value: unknown): string {
  if (typeof value !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new AppError(400, "A UUID v4 Idempotency-Key is required", "INVALID_IDEMPOTENCY_KEY");
  }
  return value.toLowerCase();
}

/** GPS is evidence for a new booking, not its identity: retries may refresh it. */
export function routeOrderRequestHash(selection: RouteOrderSelectionInput, seats: number): string {
  const input = validateRouteOrderSelectionInput(selection);
  return createHash("sha256").update(JSON.stringify([
    "configured-route-v1", input.routeId, input.direction, input.expectedUpdatedAt,
    input.pickupStopId ?? null, input.destinationStopId ?? null,
    boundedInteger(seats, "seats", 1, 8),
  ])).digest("hex");
}

export function assertRouteOrderRequestHash(actualHash: string, expectedHash: string): void {
  if (actualHash !== expectedHash) {
    throw new AppError(409, "This Idempotency-Key belongs to a different booking", "IDEMPOTENCY_CONFLICT");
  }
}
