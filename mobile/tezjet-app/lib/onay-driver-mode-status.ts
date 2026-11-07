export type DriverModeStatus = "unfilled" | "pending" | "approved" | "rejected" | "blocked" | "unknown";
export type DriverModeVehicle = {
  make?: string; model?: string; plate_number?: string; seat_capacity?: number;
};
export function driverModeStatus(approval: unknown, vehicle: DriverModeVehicle | null | undefined): DriverModeStatus {
  if (approval === "pending" || approval === "approved" || approval === "rejected" || approval === "blocked") return approval;
  return vehicle == null ? "unfilled" : "unknown";
}
export function hasCompleteDriverVehicle(vehicle: DriverModeVehicle | null | undefined): boolean {
  return !!vehicle && [vehicle.make, vehicle.model, vehicle.plate_number].every(v => typeof v === "string" && v.trim().length > 0)
    && Number.isSafeInteger(vehicle.seat_capacity) && (vehicle.seat_capacity ?? 0) >= 1 && (vehicle.seat_capacity ?? 0) <= 8;
}
/** Informational guard only; actual queue authorization stays on server and in existing joinQueue(). */
export function driverModeReadyForQueue(
  approval: unknown, vehicle: DriverModeVehicle | null | undefined, hasRoute: boolean, canJoinExistingQueue: boolean,
): boolean {
  return approval === "approved" && hasCompleteDriverVehicle(vehicle) && hasRoute && canJoinExistingQueue;
}
