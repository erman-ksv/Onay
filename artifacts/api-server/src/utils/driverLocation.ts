import type { Coordinates } from "../types/domain";
import { isValidCoordinates } from "./geo";

/** Socket telemetry is untrusted JSON; forward only validated coordinate fields. */
export function readDriverLocation(value: unknown): Coordinates | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  if (typeof input.lat !== "number" || typeof input.lng !== "number" ||
      (input.timestamp !== undefined && (typeof input.timestamp !== "number" ||
        !Number.isFinite(input.timestamp) || input.timestamp <= 0)) ||
      (input.isMocked !== undefined && typeof input.isMocked !== "boolean")) return undefined;
  const location: Coordinates = {
    lat: input.lat,
    lng: input.lng,
    timestamp: input.timestamp === undefined ? Date.now() : input.timestamp as number,
    ...(input.isMocked === undefined ? {} : { isMocked: input.isMocked }),
  };
  return isValidCoordinates(location) ? location : undefined;
}
