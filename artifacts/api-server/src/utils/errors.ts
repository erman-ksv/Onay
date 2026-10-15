export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;

  constructor(statusCode: number, message: string, code = "BAD_REQUEST") {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

const internalError = (): AppError =>
  new AppError(500, "Internal server error", "INTERNAL_SERVER_ERROR");

const serverMessages: Readonly<Record<number, string>> = {
  500: "Internal server error",
  502: "Upstream service unavailable",
  503: "Service temporarily unavailable",
  504: "Upstream service timed out",
};

const parserErrors: Readonly<Record<string, {
  status: number;
  code: string;
  message: string;
}>> = {
  "entity.parse.failed": { status: 400, code: "INVALID_JSON", message: "Invalid JSON body" },
  "entity.too.large": { status: 413, code: "PAYLOAD_TOO_LARGE", message: "Request body is too large" },
  "parameters.too.many": { status: 413, code: "PAYLOAD_TOO_LARGE", message: "Request body is too large" },
  "encoding.unsupported": { status: 415, code: "UNSUPPORTED_MEDIA_TYPE", message: "Request body encoding is not supported" },
  "charset.unsupported": { status: 415, code: "UNSUPPORTED_MEDIA_TYPE", message: "Request body encoding is not supported" },
  "request.size.invalid": { status: 400, code: "INVALID_REQUEST_BODY", message: "Invalid request body" },
  "querystring.parse.rangeError": { status: 400, code: "INVALID_REQUEST_BODY", message: "Invalid request body" },
  "request.aborted": { status: 400, code: "REQUEST_ABORTED", message: "Request was aborted" },
};

const connectionStates = new Set([
  "08000", "08001", "08003", "08004", "08006", "08007", "08P01",
  "57P01", "57P02", "57P03",
]);
// Never copy an arbitrary error.code: even a five-character string can be input.
const knownSqlStates = new Set([
  ...connectionStates,
  "23505", "40001", "40P01", "23502", "23503", "23514", "23P01",
  "22P02", "22001", "22003", "22007", "22012", "42703", "42P01",
  "42601", "42501", "53300", "53400", "53100", "53200", "57014",
]);

function readProperty(value: unknown, key: string): unknown {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return undefined;
  try {
    return Reflect.get(value, key);
  } catch {
    return undefined;
  }
}

function isError(value: unknown): value is Error {
  try {
    return value instanceof Error;
  } catch {
    return false;
  }
}

function isAppError(value: unknown): value is AppError {
  try {
    return value instanceof AppError;
  } catch {
    return false;
  }
}

function isUriError(value: unknown): value is URIError {
  try {
    return value instanceof URIError;
  } catch {
    return false;
  }
}

function publicAppError(error: unknown): AppError | undefined {
  if (!isAppError(error)) return undefined;
  const status = readProperty(error, "statusCode");
  const code = readProperty(error, "code");
  const message = readProperty(error, "message");
  if (typeof status !== "number" || !Number.isInteger(status) || status < 400 || status > 599 ||
      typeof code !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/.test(code) || typeof message !== "string") {
    return internalError();
  }
  return new AppError(status, status < 500 ? message : serverMessages[status] ?? serverMessages[500]!, code);
}

function parserError(error: unknown): AppError | undefined {
  if (!isError(error)) return undefined;
  const type = readProperty(error, "type");
  const mapping = typeof type === "string" && Object.hasOwn(parserErrors, type)
    ? parserErrors[type]
    : undefined;
  const status = readProperty(error, "status") ?? readProperty(error, "statusCode");
  if (mapping && status === mapping.status) {
    return new AppError(mapping.status, mapping.message, mapping.code);
  }
  if (isUriError(error) && status === 400) {
    return new AppError(400, "Invalid request path", "INVALID_REQUEST_PATH");
  }
  return undefined;
}

function sqlState(error: unknown): string | undefined {
  const visited = new Set<Error>();
  let candidate = error;
  // Drizzle wraps the pg Error in cause; bound cycles and hostile accessors.
  for (let depth = 0; depth < 8 && isError(candidate) && !visited.has(candidate); depth += 1) {
    visited.add(candidate);
    const code = readProperty(candidate, "code");
    if (typeof code === "string" && knownSqlStates.has(code)) return code;
    candidate = readProperty(candidate, "cause");
  }
  return undefined;
}

function databaseError(state: string | undefined): AppError | undefined {
  if (state === "23505") return new AppError(409, "Resource already exists", "RESOURCE_CONFLICT");
  if (state === "40001" || state === "40P01") {
    return new AppError(409, "Request conflicted with another operation", "REQUEST_CONFLICT");
  }
  if (state && connectionStates.has(state)) {
    return new AppError(503, serverMessages[503]!, "SERVICE_UNAVAILABLE");
  }
  return undefined;
}

/** Only owned business errors and explicitly recognized boundary errors are public. */
export function toPublicError(error: unknown): AppError {
  return publicAppError(error) ?? parserError(error) ?? databaseError(sqlState(error)) ?? internalError();
}

export interface SafeError {
  category: "application" | "request" | "database" | "internal";
  code: string;
  status_code: number;
  sql_state?: string;
}

/** Shared by HTTP, Socket.IO, dispatch and startup; no raw text or arbitrary properties. */
export function serializeSafeError(error: unknown): SafeError {
  const appError = publicAppError(error);
  const requestError = appError ? undefined : parserError(error);
  const state = appError || requestError ? undefined : sqlState(error);
  const publicError = appError ?? requestError ?? databaseError(state) ?? internalError();
  return {
    category: appError ? "application" : requestError ? "request" : state ? "database" : "internal",
    code: publicError.code,
    status_code: publicError.statusCode,
    ...(state ? { sql_state: state } : {}),
  };
}
