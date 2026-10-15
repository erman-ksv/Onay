import { isIP } from "node:net";
import type { Response } from "express";
import { AppError } from "./errors";
import { normalizePhone } from "./phone";
import { requiredString } from "./validation";
import { generateRequestId } from "./requestContext";

/** Reject invalid destinations before allocating a persistent phone bucket. */
export function otpPhone(value: unknown): string {
  const phone = requiredString(value, "phone_number", 32);
  if (!/^\+?\d[\d ()-]*$/.test(phone)) {
    throw new AppError(400, "phone_number is invalid", "VALIDATION_ERROR");
  }
  const normalized = normalizePhone(phone);
  if (!/^\+[1-9]\d{7,14}$/.test(normalized)) {
    throw new AppError(400, "phone_number is invalid", "VALIDATION_ERROR");
  }
  return normalized;
}

export function otpCode(value: unknown): string {
  const code = requiredString(value, "code", 12);
  if (!/^\d{6}$/.test(code)) {
    throw new AppError(400, "code must contain six digits", "VALIDATION_ERROR");
  }
  return code;
}

/** Fail closed without exposing database query parameters in API error logs. */
export async function otpStorageOperation<T>(operation: () => T | Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch {
    throw new AppError(503, "OTP service is temporarily unavailable", "OTP_STORAGE_UNAVAILABLE");
  }
}

/** Canonicalize mapped IPv4 and group IPv6 addresses by /64. */
export function otpClientKey(address: string | undefined): string {
  if (!address || isIP(address) === 0) {
    throw new AppError(503, "OTP client address is unavailable", "OTP_CLIENT_UNAVAILABLE");
  }
  if (isIP(address) === 4) return `ipv4:${address}`;

  const expandedTail = address.toLowerCase().split("%", 1)[0]!.replace(
    /\d+\.\d+\.\d+\.\d+$/,
    tail => {
      const bytes = tail.split(".").map(Number);
      return `${((bytes[0]! << 8) | bytes[1]!).toString(16)}:${((bytes[2]! << 8) | bytes[3]!).toString(16)}`;
    },
  );
  const [left, right] = expandedTail.split("::");
  const first = left ? left.split(":").map(part => parseInt(part, 16)) : [];
  const last = right ? right.split(":").map(part => parseInt(part, 16)) : [];
  const words = right === undefined
    ? first
    : [...first, ...Array<number>(8 - first.length - last.length).fill(0), ...last];
  if (words.slice(0, 5).every(word => word === 0) && words[5] === 0xffff) {
    return `ipv4:${words[6]! >> 8}.${words[6]! & 255}.${words[7]! >> 8}.${words[7]! & 255}`;
  }
  return `ipv6:${words.slice(0, 4).map(word => word.toString(16).padStart(4, "0")).join(":")}/64`;
}

export function sendOtpRateLimit(response: Response, retryAfterMs: number): void {
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  response.setHeader("Retry-After", String(seconds));
  response.status(429).json({
    error: {
      code: "OTP_RATE_LIMITED",
      message: "Too many OTP requests. Try again later.",
    },
    retry_after_seconds: seconds,
    request_id: generateRequestId(response.req, response),
  });
}
