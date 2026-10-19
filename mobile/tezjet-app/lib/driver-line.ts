import { nextTripStatus, type RideOrder, type RideStatus } from "./orders";

/** Opaque queue enrollment receipt from the server. Never synthesize an ID. */
export type LineCollectionState = {
  enrollmentId: string;
  phase: "collecting" | "departed";
  capacity: number;
};

export function parseLineCollectionState(entry: unknown): LineCollectionState | null {
  if (entry === null || entry === undefined) return null;
  if (typeof entry !== "object" || Array.isArray(entry)) throw new Error("Неверное состояние очереди водителей.");
  const collectionState = (entry as Record<string, unknown>).collectionState;
  if (collectionState === undefined || collectionState === null) return null;
  if (typeof collectionState !== "object" || Array.isArray(collectionState)) throw new Error("Неверное состояние линии.");
  const line = collectionState as Record<string, unknown>;
  if (line.version !== 1 || typeof line.enrollmentId !== "string" || !line.enrollmentId.trim() ||
      (line.phase !== "collecting" && line.phase !== "departed") ||
      typeof line.capacity !== "number" || !Number.isSafeInteger(line.capacity) ||
      line.capacity < 1 || line.capacity > 8) {
    throw new Error("Не удалось подтвердить режим линии. Обнови данные.");
  }
  return { enrollmentId: line.enrollmentId, phase: line.phase, capacity: line.capacity };
}

export function canBoardLinePassenger(line: LineCollectionState | null, order: RideOrder): boolean {
  return line?.phase === "collecting" && order.status === "arrived_at_c" &&
    typeof order.driver_id === "string" && order.driver_id.length > 0;
}

/** The collecting line must board each passenger; only /queue/depart starts the trip.
 * Keep the legacy arrival and completion buttons available when appropriate. */
export function nextDriverTripStatus(line: LineCollectionState | null, order: RideOrder): RideStatus | null {
  const next = nextTripStatus(order);
  if (line?.phase === "collecting" && next === "in_transit") return null;
  return next;
}

export function canDepartLine(line: LineCollectionState | null): boolean {
  return line?.phase === "collecting" && !!line.enrollmentId.trim();
}

export function lineDepartBody(line: LineCollectionState | null): { expected_enrollment_id: string } {
  if (!canDepartLine(line) || !line) throw new Error("Получить действующее подтверждение очереди перед отправлением.");
  return { expected_enrollment_id: line.enrollmentId };
}
