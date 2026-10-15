import type { ErrorRequestHandler } from "express";
import { logger } from "../lib/logger";
import { toPublicError } from "../utils/errors";
import { requestContext } from "../utils/requestContext";

export const errorHandler: ErrorRequestHandler = (
  error,
  request,
  response,
  next,
) => {
  const appError = toPublicError(error);
  const context = requestContext(request, response);

  if (appError.statusCode >= 500 || response.headersSent) {
    logger.error({ err: error, ...context, status_code: appError.statusCode, code: appError.code }, "API request failed");
  }

  if (response.headersSent) {
    // Express must close a response already in progress. Its default handler also
    // writes to stderr, so never delegate the original error or its stack/cause.
    const safeError = new Error("Internal server error");
    safeError.stack = "Error: Internal server error";
    next(safeError);
    return;
  }

  response.status(appError.statusCode).json({
    error: {
      code: appError.code,
      message: appError.message,
    },
    request_id: context.request_id,
  });
};
