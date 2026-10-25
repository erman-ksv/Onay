export type BookingOperation = "configured" | "legacy" | "recovery";

/** One immediate admission gate for both forms; React rendering is not a lock. */
export function createPassengerBookingGate(changed: () => void = () => {}) {
  let recoveryReady = false, pending = false, ordersReady = false, activeOrder = false;
  let owner: BookingOperation | null = null, recoveryRevision = 0, ordersRevision = 0;
  const canSubmit = () => recoveryReady && ordersReady && !pending && !activeOrder && owner === null;
  return {
    canSubmit,
    recoveryRevision: () => recoveryRevision,
    setRecovery(ready: boolean, blocked: boolean) {
      if (ready === recoveryReady && blocked === pending) return;
      recoveryReady = ready; pending = blocked; changed();
    },
    beginOrdersRead: () => ++ordersRevision,
    applyOrdersSnapshot(revision: number, value: boolean): boolean {
      if (revision !== ordersRevision) return false;
      const notify = value !== activeOrder || !ordersReady;
      activeOrder = value; ordersReady = true;
      if (notify) changed();
      return true;
    },
    setActiveOrder(value: boolean, authoritative = false) {
      // A socket/POST result supersedes every older pending GET, even when the
      // boolean stays true for another active ride.
      ordersRevision++;
      const ready = ordersReady || authoritative;
      if (value === activeOrder && ready === ordersReady) return;
      activeOrder = value; ordersReady = ready; changed();
    },
    tryStart(operation: BookingOperation): boolean {
      if (operation === "recovery" ? !recoveryReady || !pending || owner !== null : !canSubmit()) return false;
      owner = operation; changed(); return true;
    },
    finish(operation: BookingOperation) { if (owner === operation) { owner = null; changed(); } },
    /** Another form wrote the shared durable record. Rehydrate before admission. */
    recoveryChanged() { recoveryReady = false; recoveryRevision++; changed(); },
  };
}
export type PassengerBookingGate = ReturnType<typeof createPassengerBookingGate>;
