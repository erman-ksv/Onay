import { AppError } from "../utils/errors";
import { getOnayEnv } from "../utils/environment";

export interface PickupRoutingPoint {
  lat: number;
  lng: number;
}

export interface PickupRoutingCandidate {
  driverId: string;
  joinedAt: number;
  lastLocation: PickupRoutingPoint;
}

export interface PickupRoutingResult {
  driverId: string;
  /** Raw provider meters: preserve nearest-driver ordering before fare rounding. */
  distanceMeters: number;
  durationSeconds: number;
}

const SOURCES_PER_REQUEST = 50;
const REQUEST_TIMEOUT_MS = 5_000;
const OPERATION_TIMEOUT_MS = 10_000;
const MAX_CANDIDATES = 500;
const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_DISTANCE_METERS = 10_000_000;
const MAX_DURATION_SECONDS = 1_000_000;

function unavailable(): AppError {
  // Provider URLs and bodies may contain exact locations or credentials.
  return new AppError(503, "Pickup road routing is unavailable", "ROUTING_UNAVAILABLE");
}

function configuredBaseUrl(): URL {
  try {
    const configured = getOnayEnv("OSRM_URL");
    if (!configured) throw unavailable();
    const url = new URL(configured);
    if (!(["http:", "https:"] as string[]).includes(url.protocol) ||
        !url.hostname || url.username || url.password || url.search || url.hash) {
      throw unavailable();
    }
    return url;
  } catch {
    throw unavailable();
  }
}

function validPoint(value: PickupRoutingPoint): boolean {
  return value !== null && typeof value === "object" &&
    Number.isFinite(value.lat) && value.lat >= -90 && value.lat <= 90 &&
    Number.isFinite(value.lng) && value.lng >= -180 && value.lng <= 180;
}

async function boundedJson(response: Response): Promise<unknown> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null &&
      (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_RESPONSE_BYTES)) {
    if (response.body) void response.body.cancel().catch(() => undefined);
    throw unavailable();
  }
  if (!response.body) throw unavailable();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) throw unavailable();
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    void reader.cancel().catch(() => undefined);
    throw unavailable();
  } finally {
    reader.releaseLock();
  }
}

function matrix(value: unknown, rows: number): unknown[][] {
  if (!Array.isArray(value) || value.length !== rows ||
      value.some((row) => !Array.isArray(row) || row.length !== 1)) {
    throw unavailable();
  }
  return value as unknown[][];
}

async function routeChunk(
  baseUrl: URL,
  candidates: readonly PickupRoutingCandidate[],
  target: PickupRoutingPoint,
  controllers: Set<AbortController>,
): Promise<PickupRoutingResult[]> {
  const points = [...candidates.map((entry) => entry.lastLocation), target];
  const coordinates = points.map((point) => `${point.lng},${point.lat}`).join(";");
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/table/v1/driving/${coordinates}`;
  url.searchParams.set("sources", candidates.map((_, index) => index).join(";"));
  url.searchParams.set("destinations", String(candidates.length));
  url.searchParams.set("annotations", "distance,duration");
  url.searchParams.set("skip_waypoints", "true");
  const controller = new AbortController();
  controllers.add(controller);
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) {
      if (response.body) void response.body.cancel().catch(() => undefined);
      throw unavailable();
    }
    const body = await boundedJson(response);
    if (body === null || typeof body !== "object" || Array.isArray(body) ||
        (body as Record<string, unknown>)["code"] !== "Ok") throw unavailable();
    const record = body as Record<string, unknown>;
    const distances = matrix(record["distances"], candidates.length);
    const durations = matrix(record["durations"], candidates.length);
    const results: PickupRoutingResult[] = [];
    for (let index = 0; index < candidates.length; index += 1) {
      const distance = distances[index]![0];
      const duration = durations[index]![0];
      if (distance === null && duration === null) continue;
      if (typeof distance !== "number" || !Number.isFinite(distance) ||
          distance < 0 || distance > MAX_DISTANCE_METERS ||
          typeof duration !== "number" || !Number.isFinite(duration) ||
          duration < 0 || duration > MAX_DURATION_SECONDS) throw unavailable();
      results.push({
        driverId: candidates[index]!.driverId,
        distanceMeters: distance,
        durationSeconds: duration,
      });
    }
    return results;
  } catch {
    throw unavailable();
  } finally {
    clearTimeout(timeout);
    controllers.delete(controller);
  }
}

/** Road distance from each driver's current location to the passenger, one way. */
export async function routePickupCandidates(
  candidates: readonly PickupRoutingCandidate[],
  target: PickupRoutingPoint,
): Promise<PickupRoutingResult[]> {
  const baseUrl = configuredBaseUrl();
  if (candidates.length > MAX_CANDIDATES || !validPoint(target) || candidates.some((entry) =>
    typeof entry.driverId !== "string" || !entry.driverId ||
    !Number.isSafeInteger(entry.joinedAt) || entry.joinedAt < 0 ||
    !validPoint(entry.lastLocation))) throw unavailable();
  if (candidates.length === 0) return [];
  const chunks: Array<readonly PickupRoutingCandidate[]> = [];
  for (let offset = 0; offset < candidates.length; offset += SOURCES_PER_REQUEST) {
    chunks.push(candidates.slice(offset, offset + SOURCES_PER_REQUEST));
  }
  const results: PickupRoutingResult[][] = new Array(chunks.length);
  const controllers = new Set<AbortController>();
  let nextChunk = 0;
  let failed = false;
  async function worker(): Promise<void> {
    while (!failed && nextChunk < chunks.length) {
      const index = nextChunk++;
      try {
        results[index] = await routeChunk(baseUrl, chunks[index]!, target, controllers);
      } catch {
        failed = true;
        for (const controller of controllers) controller.abort();
        throw unavailable();
      }
    }
  }
  const operationTimeout = setTimeout(() => {
    failed = true;
    for (const controller of controllers) controller.abort();
  }, OPERATION_TIMEOUT_MS);
  try {
    // Await both workers even on failure so no request outlives the quote operation.
    const workers = await Promise.allSettled(
      Array.from({ length: Math.min(2, chunks.length) }, () => worker()),
    );
    if (failed || workers.some((result) => result.status === "rejected")) throw unavailable();
  } finally {
    clearTimeout(operationTimeout);
  }
  const joinedAt = new Map(candidates.map((entry) => [entry.driverId, entry.joinedAt]));
  return results.flat().sort((left, right) =>
    left.distanceMeters - right.distanceMeters ||
    joinedAt.get(left.driverId)! - joinedAt.get(right.driverId)! ||
    (left.driverId < right.driverId ? -1 : left.driverId > right.driverId ? 1 : 0));
}
