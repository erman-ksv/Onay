import { parseDriverQueueMembership, type QueueMembership } from "./driver-queue.ts";
import { parseLineCollectionState } from "./driver-line.ts";

export type SeatReadScope = { sessionKey: string; driverId: string; revision: number };
export type DriverSeatSnapshot = SeatReadScope & { checkedAt: number } & (
  { membership: "absent" } |
  { membership: "enrolled"; availableSeats: number; joinedAt: number; enrollmentId?: string }
);
export type DriverSeatView = { status: "unknown" } | { status: "absent" } | { status: "known"; availableSeats: number };
export const DRIVER_SEATS_MAX_AGE_MS = 15_000;

/** Only the driver's own authoritative queue entry proves remaining seats.
 * FIFO position, collection capacity and client order arithmetic do not. */
export function parseDriverSeatSnapshot(input: unknown, scope: SeatReadScope, checkedAt: number): DriverSeatSnapshot {
  const invalid = () => new Error("Не удалось подтвердить свободные места. Обнови очередь.");
  if (!scope.sessionKey.trim() || !scope.driverId.trim() || !Number.isSafeInteger(scope.revision) || scope.revision < 0 ||
    !Number.isSafeInteger(checkedAt) || checkedAt < 0) throw invalid();
  const membership = parseDriverQueueMembership(input);
  if (membership === "absent") return { ...scope, checkedAt, membership };
  const entry = (input as { your_entry: Record<string, unknown> }).your_entry;
  if (entry.driverId !== scope.driverId || !Number.isSafeInteger(entry.availableSeats) ||
    Number(entry.availableSeats) < 0 || Number(entry.availableSeats) > 8 ||
    !Number.isSafeInteger(entry.joinedAt) || Number(entry.joinedAt) < 0) throw invalid();
  const line = parseLineCollectionState(entry);
  return { ...scope, checkedAt, membership, availableSeats: Number(entry.availableSeats), joinedAt: Number(entry.joinedAt),
    ...(line ? { enrollmentId: line.enrollmentId } : {}) };
}

/** Revision fences order/queue events and mutations, including in-flight reads. */
export function driverSeatView(snapshot: DriverSeatSnapshot | null, scope: SeatReadScope, now: number, membership: QueueMembership): DriverSeatView {
  if (!snapshot || !scope.sessionKey || !scope.driverId || snapshot.sessionKey !== scope.sessionKey || snapshot.driverId !== scope.driverId ||
    snapshot.revision !== scope.revision || !Number.isFinite(now) || now < snapshot.checkedAt ||
    now - snapshot.checkedAt >= DRIVER_SEATS_MAX_AGE_MS || membership === "unknown" || snapshot.membership !== membership) return { status: "unknown" };
  return snapshot.membership === "absent" ? { status: "absent" } : { status: "known", availableSeats: snapshot.availableSeats };
}
