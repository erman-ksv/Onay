import type { Coordinates } from "../types/domain";

const configuredSessionSecret = process.env.SESSION_SECRET;

if (
  process.env.NODE_ENV === "production" &&
  (!configuredSessionSecret || configuredSessionSecret.length < 32)
) {
  throw new Error(
    "SESSION_SECRET must be configured with at least 32 characters in production",
  );
}

export const JWT_SECRET =
  configuredSessionSecret ?? "tezjet-development-secret";
export const JWT_EXPIRES_IN = "7d" as const;
export const OTP_TTL_MS = 5 * 60 * 1000;
export const QUEUE_GEOFENCE_METERS = Number(
  process.env.PYATAK_GEOFENCE_METERS ?? 150,
);
export const MAX_SPEED_KMH = 180;
export const SEAT_LOCK_TTL_MS = 7 * 60 * 1000;
const offerTimeoutSeconds = Number(process.env.TEZJET_OFFER_TIMEOUT_SECONDS ?? 60);
if (!Number.isInteger(offerTimeoutSeconds) || offerTimeoutSeconds < 1 || offerTimeoutSeconds > 3600) {
  throw new Error("TEZJET_OFFER_TIMEOUT_SECONDS must be an integer between 1 and 3600");
}
export const OFFER_TIMEOUT_MS = offerTimeoutSeconds * 1000;
export const ADMIN_PHONE = process.env.ADMIN_PHONE
  ? process.env.ADMIN_PHONE.replace(/[^\d+]/g, "")
  : undefined;
export const REQUIRE_DRIVER_APPROVAL =
  process.env.REQUIRE_DRIVER_APPROVAL !== "false";
export const PYATAK_ZONE: {
  id: string;
  name: string;
  radiusMeters: number;
  center: Coordinates;
} = {
  id: "pyatak",
  name: "Pyatak",
  radiusMeters: QUEUE_GEOFENCE_METERS,
  center: {
    lat: Number(
      process.env.PYATAK_CENTER_LAT ?? process.env.QUEUE_CENTER_LAT ?? 41.3111,
    ),
    lng: Number(
      process.env.PYATAK_CENTER_LNG ?? process.env.QUEUE_CENTER_LNG ?? 69.2797,
    ),
    timestamp: Date.now(),
  },
};

export function updatePyatakCenter(center: Coordinates): Coordinates {
  PYATAK_ZONE.center = {
    ...center,
    timestamp: Date.now(),
  };
  return { ...PYATAK_ZONE.center };
}

export const DEFAULT_QUEUE_POINT: Coordinates = {
  ...PYATAK_ZONE.center,
  timestamp: Date.now(),
};
