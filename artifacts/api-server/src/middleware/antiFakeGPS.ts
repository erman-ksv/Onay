import type { NextFunction, Request, Response } from "express";
import { store } from "../store";
import type { Coordinates } from "../types/domain";
import { MAX_SPEED_KMH } from "../utils/config";
import { isValidCoordinates, speedKmh } from "../utils/geo";
import { AppError } from "../utils/errors";
import { translate } from "../utils/i18n";

function readLocation(request: Request): Coordinates | undefined {
  const raw =
    request.body?.location ??
    request.body?.coordinates ??
    request.body?.pickup_location;
  if (!raw || typeof raw !== "object") {
    return undefined;
  }

  const input = raw as Record<string, unknown>;
  return {
    lat: Number(input["lat"]),
    lng: Number(input["lng"]),
    timestamp: input["timestamp"] ? Number(input["timestamp"]) : Date.now(),
    isMocked: input["isMocked"] === true,
  };
}

export async function antiFakeGPS(
  request: Request,
  _response: Response,
  next: NextFunction,
): Promise<void> {
  const location = readLocation(request);
  if (!location) {
    next();
    return;
  }

  if (!isValidCoordinates(location)) {
    throw new AppError(422, "Invalid coordinates", "INVALID_COORDINATES");
  }
  if (location.isMocked) {
    throw new AppError(
      422,
      translate(request.auth?.locale ?? "ru", "fakeGps"),
      "MOCKED_GPS",
    );
  }

  const previous = request.auth?.user.lastLocation;
  if (previous) {
    const currentSpeed = speedKmh(previous, location);
    if (currentSpeed > MAX_SPEED_KMH) {
      throw new AppError(
        422,
        translate(request.auth?.locale ?? "ru", "tooFast"),
        "GPS_SPEED_LIMIT",
      );
    }
  }

  if (request.auth) {
    await store.updateUser(request.auth.userId, { lastLocation: location });
    request.auth.user.lastLocation = location;
  }
  next();
}