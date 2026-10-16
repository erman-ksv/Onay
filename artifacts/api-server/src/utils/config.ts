import type { Coordinates } from "../types/domain";
import { getOnayEnv } from "./environment";

const configuredSessionSecret = process.env.SESSION_SECRET;

if (
  process.env.NODE_ENV === "production" &&
  (!configuredSessionSecret || configuredSessionSecret.length < 32)
) {
  throw new Error(
    "SESSION_SECRET must be configured with at least 32 characters in production",
  );
}

// Retain the legacy development key so existing local sessions remain valid.
export const JWT_SECRET =
  configuredSessionSecret ?? "tezjet-development-secret";
export const JWT_EXPIRES_IN = "7d" as const;
export const OTP_TTL_MS = 5 * 60 * 1000;

function otpSetting(name: string, fallback: number, maximum: number): number {
  const value = Number(getOnayEnv(name) ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`ONAY_${name} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

/** Shared by every OTP endpoint and storage adapter; no test/development bypass. */
export const OTP_LIMITS = Object.freeze({
  resendCooldownMs: otpSetting("OTP_RESEND_SECONDS", 60, 3600) * 1000,
  sendWindowMs: otpSetting("OTP_SEND_WINDOW_SECONDS", 3600, 86400) * 1000,
  sendMax: otpSetting("OTP_SEND_MAX", 5, 1000),
  failureWindowMs: otpSetting("OTP_FAILURE_WINDOW_SECONDS", 900, 86400) * 1000,
  failureMax: otpSetting("OTP_FAILURE_MAX", 5, 100),
  blockMs: otpSetting("OTP_BLOCK_SECONDS", 900, 86400) * 1000,
  ipWindowMs: otpSetting("OTP_IP_WINDOW_SECONDS", 900, 86400) * 1000,
  ipMax: otpSetting("OTP_IP_MAX", 120, 10000),
});
export const QUEUE_GEOFENCE_METERS = Number(
  process.env.PYATAK_GEOFENCE_METERS ?? 150,
);
export const MAX_SPEED_KMH = 180;
export const SEAT_LOCK_TTL_MS = 7 * 60 * 1000;
const offerTimeoutSeconds = Number(getOnayEnv("OFFER_TIMEOUT_SECONDS") ?? 60);
if (!Number.isInteger(offerTimeoutSeconds) || offerTimeoutSeconds < 1 || offerTimeoutSeconds > 3600) {
  throw new Error("ONAY_OFFER_TIMEOUT_SECONDS must be an integer between 1 and 3600");
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
