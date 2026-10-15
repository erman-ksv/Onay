import { createHmac } from "node:crypto";
import { JWT_SECRET, OTP_LIMITS } from "../utils/config";
import { normalizePhone } from "../utils/phone";
import type { OtpLimitResult } from "./storeContract";

/** Unix millisecond timestamps; all transitions are shared by both adapters. */
export interface OtpRateState {
  windowStartedAt: number;
  count: number;
  nextAllowedAt: number;
  blockedUntil: number;
}

export type OtpRateKind = "send" | "verify" | "ip";
export const OTP_CLEANUP_BATCH_SIZE = 100;

/** Purpose separation prevents a send, failure, or shared IP bucket from colliding. */
export function otpRateKey(kind: OtpRateKind, identity: string): string {
  const canonicalIdentity = kind === "ip" ? identity : normalizePhone(identity);
  return createHmac("sha256", JWT_SECRET)
    .update(`${kind}\0${canonicalIdentity}`)
    .digest("hex");
}

export function emptyOtpRateState(): OtpRateState {
  return { windowStartedAt: 0, count: 0, nextAllowedAt: 0, blockedUntil: 0 };
}

function currentWindow(state: OtpRateState, windowMs: number, now: number): OtpRateState {
  return state.count === 0 || state.windowStartedAt + windowMs <= now
    ? { ...state, windowStartedAt: now, count: 0 }
    : { ...state };
}

export function otpFailureState(state: OtpRateState, now: number): OtpRateState {
  // An active block wins even if the original failure window already ended.
  if (state.blockedUntil > now) return { ...state };
  // A completed block grants a fresh failure budget, including when operators
  // configure a failure window longer than the block duration.
  if (state.blockedUntil > 0) return { ...emptyOtpRateState(), windowStartedAt: now };
  return currentWindow(state, OTP_LIMITS.failureWindowMs, now);
}

export function otpPhoneBlock(state: OtpRateState, now: number): OtpLimitResult {
  return state.blockedUntil > now
    ? { allowed: false, retryAfterMs: state.blockedUntil - now }
    : { allowed: true };
}

export function takeOtpSend(state: OtpRateState, now: number): {
  state: OtpRateState;
  result: OtpLimitResult;
} {
  const next = currentWindow(state, OTP_LIMITS.sendWindowMs, now);
  const retryAt = Math.max(
    next.nextAllowedAt,
    next.count >= OTP_LIMITS.sendMax ? next.windowStartedAt + OTP_LIMITS.sendWindowMs : 0,
  );
  if (retryAt > now) {
    return { state: next, result: { allowed: false, retryAfterMs: retryAt - now } };
  }
  next.count += 1;
  next.nextAllowedAt = now + OTP_LIMITS.resendCooldownMs;
  return { state: next, result: { allowed: true } };
}

export function takeOtpIp(state: OtpRateState, now: number): {
  state: OtpRateState;
  result: OtpLimitResult;
} {
  const next = currentWindow(state, OTP_LIMITS.ipWindowMs, now);
  if (next.count >= OTP_LIMITS.ipMax) {
    return {
      state: next,
      result: { allowed: false, retryAfterMs: next.windowStartedAt + OTP_LIMITS.ipWindowMs - now },
    };
  }
  next.count += 1;
  return { state: next, result: { allowed: true } };
}

export function recordOtpFailure(state: OtpRateState, now: number): OtpRateState {
  const next = otpFailureState(state, now);
  next.count += 1;
  if (next.count >= OTP_LIMITS.failureMax) next.blockedUntil = now + OTP_LIMITS.blockMs;
  return next;
}

export function otpRateExpiresAt(kind: OtpRateKind, state: OtpRateState): number {
  const windowMs = kind === "send" ? OTP_LIMITS.sendWindowMs
    : kind === "verify" ? OTP_LIMITS.failureWindowMs : OTP_LIMITS.ipWindowMs;
  return Math.max(state.windowStartedAt + windowMs, state.nextAllowedAt, state.blockedUntil);
}
