import type { NextFunction, Request, Response } from "express";
import type { AuthContext } from "../types/express";
import { store } from "../store";
import { AppError } from "../utils/errors";
import { translate } from "../utils/i18n";
import { verifyAccessToken } from "../utils/token";

function readBearerToken(request: Request): string | null {
  const header = request.header("authorization");
  if (!header?.startsWith("Bearer ")) {
    return null;
  }
  return header.slice("Bearer ".length).trim() || null;
}

export async function authenticate(
  request: Request,
  _response: Response,
  next: NextFunction,
): Promise<void> {
  const token = readBearerToken(request);
  const claims = token ? verifyAccessToken(token) : null;
  const user = claims?.sub ? await store.getUser(claims.sub) : undefined;

  if (
    !claims ||
    !user ||
    user.sessionVersion !== claims.sessionVersion ||
    user.role !== claims.role
  ) {
    throw new AppError(401, translate("ru", "unauthorized"), "UNAUTHORIZED");
  }

  const auth: AuthContext = {
    userId: user.id,
    role: user.role,
    locale: user.locale,
    user,
  };
  request.auth = auth;
  next();
}

export function requireRole(
  ...roles: AuthContext["role"][]
): (request: Request, response: Response, next: NextFunction) => void {
  return (request, _response, next) => {
    if (!request.auth || !roles.includes(request.auth.role)) {
      throw new AppError(403, "You do not have permission for this operation", "FORBIDDEN");
    }
    next();
  };
}

export function requireApprovedDriver(
  request: Request,
  _response: Response,
  next: NextFunction,
): void {
  if (!request.auth || request.auth.role !== "driver") {
    throw new AppError(403, "Driver access is required", "FORBIDDEN");
  }
  if (
    process.env.REQUIRE_DRIVER_APPROVAL !== "false" &&
    request.auth.user.driverApprovalStatus !== "approved"
  ) {
    throw new AppError(
      403,
      "Your driver account must be approved before using driver features",
      "DRIVER_APPROVAL_REQUIRED",
    );
  }
  next();
}

export function readSocketToken(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  return value.startsWith("Bearer ") ? value.slice(7).trim() : value.trim();
}