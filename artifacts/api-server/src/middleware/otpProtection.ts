import type { NextFunction, Request, Response } from "express";
import { store } from "../store";
import { otpClientKey, otpStorageOperation, sendOtpRateLimit } from "../utils/otpRequest";

function isOtpRequest(request: Request): boolean {
  return request.method === "POST" && /^\/auth\/(?:request-otp|verify-otp|login)\/?$/i.test(request.path);
}

/** Mounted at /api before body parsers; malformed OTP bodies also consume budget. */
export async function protectOtpRequests(
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  if (!isOtpRequest(request)) {
    next();
    return;
  }
  // Express defaults to trust proxy=false. Never trust raw forwarding headers.
  const clientKey = otpClientKey(request.ip ?? request.socket.remoteAddress);
  const result = await otpStorageOperation(() => store.takeOtpIpBudget(clientKey));
  if (!result.allowed) {
    sendOtpRateLimit(response, result.retryAfterMs);
    return;
  }
  next();
}
