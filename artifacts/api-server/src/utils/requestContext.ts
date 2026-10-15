import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

const requestIds = new WeakMap<object, string>();
const apiRequests = new WeakSet<object>();
const methods = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "CONNECT", "TRACE"]);

interface ContextRequest extends IncomingMessage {
  baseUrl?: string;
  route?: { path?: unknown };
}

export interface RequestContext {
  request_id: string;
  method: string;
  route: string;
}

/** IDs belong to this server. Incoming headers and caller-supplied req.id are ignored. */
export function generateRequestId(request: IncomingMessage, response?: ServerResponse): string {
  let id = requestIds.get(request);
  if (!id) {
    id = randomUUID();
    requestIds.set(request, id);
  }
  if (response && !response.headersSent) response.setHeader("X-Request-Id", id);
  return id;
}

export function markApiRequest(request: IncomingMessage): void {
  apiRequests.add(request);
}

export function requestContext(request: ContextRequest, response?: ServerResponse): RequestContext {
  const path = request.route?.path;
  return {
    request_id: generateRequestId(request, response),
    method: request.method && methods.has(request.method) ? request.method : "OTHER",
    // Express supplies its registered route template, never a URL or parameter value.
    route: typeof path === "string" ? `${apiRequests.has(request) || request.baseUrl === "/api" ? "/api" : ""}${path}` : "unmatched",
  };
}
