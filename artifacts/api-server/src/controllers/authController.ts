import type { Request, Response } from "express";
import { randomInt, randomUUID } from "node:crypto";
import { store } from "../store";
import type { Locale, User } from "../types/domain";
import { createAccessToken } from "../utils/token";
import { normalizePhone } from "../utils/phone";
import { otpCode, otpPhone, otpStorageOperation, sendOtpRateLimit } from "../utils/otpRequest";
import { serializeUser } from "../utils/serialize";
import { translate } from "../utils/i18n";
import { AppError } from "../utils/errors";
import { ADMIN_PHONE, OTP_TTL_MS } from "../utils/config";
import { optionalString, pickEnum, requiredString } from "../utils/validation";
import { getSmsConfiguration, OtpSmsError, sendOtpSms } from "../services/otpSms";

const roles = ["passenger", "driver", "admin"] as const;
const locales = ["kk", "uz", "ru"] as const;

function getLocale(request: Request, value: unknown): Locale {
  return pickEnum(value ?? request.auth?.locale ?? "ru", "locale", locales);
}

function disconnectPreviousSessions(request: Request, userId: string): void {
  request.app?.locals.io?.in(`user:${userId}`).disconnectSockets(true);
}

function issueToken(user: User): string {
  return createAccessToken({
    sub: user.id,
    role: user.role,
    locale: user.locale,
    sessionVersion: user.sessionVersion,
    sessionId: randomUUID(),
  });
}

export async function requestOtp(request: Request, response: Response): Promise<void> {
  const phoneNumber = otpPhone(request.body?.phone_number);
  const role = pickEnum(request.body?.role ?? "passenger", "role", roles);
  if (
    role === "admin" &&
    (!ADMIN_PHONE || phoneNumber !== normalizePhone(ADMIN_PHONE))
  ) {
    throw new AppError(403, "Admin registration is not available", "ADMIN_REGISTRATION_DISABLED");
  }
  const locale = getLocale(request, request.body?.locale);
  const fullName = optionalString(request.body?.full_name, "full_name", 120);
  // Production must never report a sent code when no real sender is configured.
  const sms = getSmsConfiguration();
  if (sms.kind === "devsms" && !/^\+998\d{9}$/.test(phoneNumber)) {
    throw new AppError(422, "SMS login currently supports Uzbekistan numbers only", "SMS_UNSUPPORTED_COUNTRY");
  }
  const code = String(randomInt(100000, 1_000_000));
  const deliveryId = sms.kind === "devsms" ? randomUUID() : undefined;

  const admission = await otpStorageOperation(() => store.saveOtpProtected({
    phoneNumber,
    code,
    role,
    locale,
    fullName,
    expiresAt: Date.now() + OTP_TTL_MS,
    ...(deliveryId ? { deliveryId } : {}),
  }));

  if (!admission.allowed) {
    sendOtpRateLimit(response, admission.retryAfterMs);
    return;
  }

  if (sms.kind === "devsms" && deliveryId) {
    try {
      await sendOtpSms(sms, { phoneNumber, code, deliveryId });
    } catch (error) {
      if (error instanceof OtpSmsError && error.definitive) {
        // Do not erase a newer challenge or refund an abuse-control budget.
        await otpStorageOperation(() => store.discardOtpDelivery(phoneNumber, deliveryId));
      }
      // Unknown outcomes may have delivered the code: retain its bounded TTL,
      // but never claim a successful send or automatically send another SMS.
      if (error instanceof OtpSmsError) throw error;
      throw new AppError(503, "SMS outcome is not confirmed", "SMS_OUTCOME_UNKNOWN");
    }
  }

  response.status(202).json({
    message: translate(locale, "otpSent"),
    expires_in_seconds: OTP_TTL_MS / 1000,
    ...(sms.kind === "demo" ? { demo_code: code } : {}),
  });
}

export async function verifyOtp(request: Request, response: Response): Promise<void> {
  const phoneNumber = otpPhone(request.body?.phone_number);
  const code = otpCode(request.body?.code);
  const verification = await otpStorageOperation(() => store.consumeOtpProtected(phoneNumber, code));
  if (verification.status === "limited") {
    sendOtpRateLimit(response, verification.retryAfterMs);
    return;
  }
  if (verification.status === "invalid") {
    throw new AppError(401, translate("ru", "invalidOtp"), "INVALID_OTP");
  }
  const challenge = verification.challenge;

  let user = await store.getUserByPhone(phoneNumber);
  if (!user) {
    const fullName = requiredString(challenge.fullName ?? request.body?.full_name, "full_name", 120);
    user = await store.createUser({
      role: challenge.role,
      fullName,
      phoneNumber,
      locale: challenge.locale,
    });
    user = await store.invalidateSessions(user.id);
  } else if (user.role !== challenge.role) {
    if (challenge.role === "admin" || user.role === "admin") {
      throw new AppError(403, "Admin role cannot be assigned or changed on this account", "ADMIN_ROLE_FORBIDDEN");
    }
    user = await store.activateUserRole(user.id, challenge.role);
  } else {
    user = await store.invalidateSessions(user.id);
  }

  const token = issueToken(user);
  disconnectPreviousSessions(request, user.id);
  response.json({
    access_token: token,
    token_type: "Bearer",
    user: serializeUser(user),
    session_policy: "previous_tokens_invalidated",
  });
}

export async function switchRole(request: Request, response: Response): Promise<void> {
  if (!request.auth) {
    throw new AppError(401, translate("ru", "unauthorized"), "UNAUTHORIZED");
  }
  const role = pickEnum(request.body?.role, "role", ["passenger", "driver"] as const);
  const user = await store.activateUserRole(request.auth.userId, role, request.auth.user.sessionVersion);
  disconnectPreviousSessions(request, user.id);
  response.json({
    access_token: issueToken(user),
    token_type: "Bearer",
    user: serializeUser(user),
    session_policy: "previous_tokens_invalidated",
  });
}

export function getCurrentUser(request: Request, response: Response): void {
  if (!request.auth) {
    throw new AppError(401, translate("ru", "unauthorized"), "UNAUTHORIZED");
  }
  response.json({ user: serializeUser(request.auth.user) });
}

export async function updateProfile(request: Request, response: Response): Promise<void> {
  if (!request.auth) {
    throw new AppError(401, translate("ru", "unauthorized"), "UNAUTHORIZED");
  }
  const incomingName = request.body?.full_name;
  const incomingPhone = request.body?.phone_number;
  if (
    (incomingName !== undefined && incomingName !== request.auth.user.fullName) ||
    (incomingPhone !== undefined &&
      normalizePhone(String(incomingPhone)) !== request.auth.user.phoneNumber)
  ) {
    throw new AppError(
      409,
      translate(request.auth.user.locale, "profileLocked"),
      "PROFILE_LOCKED",
    );
  }

  const locale = request.body?.locale
    ? getLocale(request, request.body.locale)
    : request.auth.user.locale;
  const user = await store.updateUser(request.auth.userId, { locale });
  response.json({ user: serializeUser(user) });
}

export async function logout(request: Request, response: Response): Promise<void> {
  if (request.auth) {
    const { userId, user } = request.auth;
    await store.invalidateSessions(userId, user.sessionVersion);
    // A new login may commit while socket cleanup is awaiting its snapshot.
    // Disconnect only the session that this logout actually revoked.
    const io = request.app?.locals.io;
    if (io) {
      const sockets = await io.in(`user:${userId}`).fetchSockets();
      for (const socket of sockets) {
        if (socket.data.sessionVersion === user.sessionVersion) socket.disconnect(true);
      }
    }
  }
  response.status(204).send();
}
