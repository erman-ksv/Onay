/** FIFO position and a live queue enrollment describe different states. */
export type QueueMembership = "unknown" | "enrolled" | "absent";
export type DriverQueueSnapshot = { sessionKey: string; membership: QueueMembership };

/** Only a complete authoritative /queue response may establish absence.
 * Departed lines and completed configured trips can retain an entry while
 * their FIFO position is null; they must be left before another enrollment. */
export function parseDriverQueueMembership(value: unknown): "enrolled" | "absent" {
  const invalid = () => new Error("Не удалось подтвердить состояние очереди. Обнови данные.");
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !Object.prototype.hasOwnProperty.call(value, "your_entry") || !Object.prototype.hasOwnProperty.call(value, "your_position")) {
    throw invalid();
  }
  const snapshot = value as Record<string, unknown>;
  const entry = snapshot.your_entry;
  const position = snapshot.your_position;
  if (position !== null && (typeof position !== "number" || !Number.isSafeInteger(position) || position < 1)) {
    throw invalid();
  }
  if (entry === null) {
    if (position !== null) throw invalid();
    return "absent";
  }
  if (typeof entry !== "object" || Array.isArray(entry)) throw invalid();
  return "enrolled";
}

/** A result from another endpoint/account/session cannot authorize a new join. */
export function driverQueueMembership(snapshot: DriverQueueSnapshot | null, sessionKey: string): QueueMembership {
  if (!sessionKey.trim() || !snapshot || snapshot.sessionKey !== sessionKey) return "unknown";
  return snapshot.membership === "enrolled" || snapshot.membership === "absent" ? snapshot.membership : "unknown";
}

/** React's disabled state applies on the next render. Hold this guard until the
 * request settles so two DELETEs cannot straddle a later queue enrollment. */
export function createQueueMutationGuard() {
  let pending = false;
  return {
    tryStart(): boolean {
      if (pending) return false;
      pending = true;
      return true;
    },
    finish(): void { pending = false; },
    isPending(): boolean { return pending; },
  };
}
