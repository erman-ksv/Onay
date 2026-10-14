import type { ErrorRequestHandler, NextFunction, Request, Response } from "express";
import { store } from "../store";
import { AppError } from "../utils/errors";
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

/** Keep rejected OTP parser input out of 500 logs, which may include its body. */
export const otpBodyError: ErrorRequestHandler = (error: unknown, request, _response, next) => {
  const parserType = error !== null && typeof error === "object" && "type" in error ? error.type : undefined;
  if (isOtpRequest(request) && parserType === "entity.parse.failed") {
    next(new AppError(400, "OTP request body is invalid", "VALIDATION_ERROR"));
  } else if (isOtpRequest(request) && parserType === "entity.too.large") {
    next(new AppError(413, "OTP request body is too large", "VALIDATION_ERROR"));
  } else {
    next(error);
  }
};
