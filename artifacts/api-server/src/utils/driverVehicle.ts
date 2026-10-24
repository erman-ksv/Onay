import { randomUUID } from "node:crypto";
import type { DriverVehicle, DriverVehicleInput, User } from "../types/domain";
import { AppError } from "./errors";

function text(value: unknown, field: string, max: number): string {
  const normalized = typeof value === "string" ? value.trim().normalize("NFKC") : "";
  if (!normalized || normalized.length > max || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new AppError(400, `Invalid ${field}`, "VALIDATION_ERROR");
  }
  return normalized;
}

export function validateDriverVehicleInput(value: DriverVehicleInput): DriverVehicleInput {
  if (!value || (value.expectedRevision !== null && (typeof value.expectedRevision !== "string" || !value.expectedRevision.trim() || value.expectedRevision.length > 80))) {
    throw new AppError(400, "An explicit vehicle revision is required", "VALIDATION_ERROR");
  }
  const plateNumber = text(value.plateNumber, "plate_number", 20).replace(/\s+/g, " ").toUpperCase();
  if (!/^[\p{L}\p{N} -]{3,20}$/u.test(plateNumber) || !/\d/.test(plateNumber) ||
      !Number.isSafeInteger(value.seatCapacity) || value.seatCapacity < 1 || value.seatCapacity > 8) {
    throw new AppError(400, "Invalid plate_number or seat_capacity", "VALIDATION_ERROR");
  }
  return { make: text(value.make, "make", 40), model: text(value.model, "model", 60), plateNumber,
    seatCapacity: value.seatCapacity, expectedRevision: value.expectedRevision };
}

export function readDriverVehicleInput(body: unknown): DriverVehicleInput {
  const fields = ["make", "model", "plate_number", "seat_capacity", "expected_revision"];
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).some(key => !fields.includes(key)) || !Object.prototype.hasOwnProperty.call(body, "expected_revision")) {
    throw new AppError(400, "Invalid vehicle fields", "VALIDATION_ERROR");
  }
  const value = body as Record<string, unknown>;
  return validateDriverVehicleInput({ make: value.make, model: value.model, plateNumber: value.plate_number,
    seatCapacity: value.seat_capacity, expectedRevision: value.expected_revision } as DriverVehicleInput);
}

export function createDriverVehicle(input: DriverVehicleInput, current?: DriverVehicle): DriverVehicle {
  const value = validateDriverVehicleInput(input);
  if ((current?.revision ?? null) !== value.expectedRevision) {
    throw new AppError(409, "Vehicle changed; reload before saving", "VEHICLE_CHANGED");
  }
  return { version: 1, revision: randomUUID(), make: value.make, model: value.model,
    plateNumber: value.plateNumber, seatCapacity: value.seatCapacity, updatedAt: new Date().toISOString() };
}

export function assertVehicleReview(user: User, expectedRevision?: string | null): void {
  if ((user.driverVehicle?.revision ?? null) !== (expectedRevision ?? null)) {
    throw new AppError(409, "Vehicle changed; review its current revision", "VEHICLE_REVIEW_CHANGED");
  }
}

export function assertVehicleQueueCapacity(user: User, seats: number): void {
  if (!user.driverVehicle) return; // Existing approved accounts retain their legacy contract.
  if (user.driverApprovalStatus !== "approved") throw new AppError(403, "Vehicle review is required", "VEHICLE_REVIEW_REQUIRED");
  if (!Number.isSafeInteger(user.driverVehicle.seatCapacity) || user.driverVehicle.seatCapacity < 1 || user.driverVehicle.seatCapacity > 8 ||
      !Number.isSafeInteger(seats) || seats < 1 || seats > user.driverVehicle.seatCapacity) {
    throw new AppError(400, "Available seats exceed the vehicle capacity", "VEHICLE_CAPACITY_EXCEEDED");
  }
}

export function publicDriverVehicle(vehicle: DriverVehicle) {
  return { make: vehicle.make, model: vehicle.model, plate_number: vehicle.plateNumber, seat_capacity: vehicle.seatCapacity };
}

/** Development approval bypass applies only to accounts without a saved car.
 * A submitted car always requires current approval, including after revocation. */
export function hasRequiredDriverApproval(
  user: { driverApprovalStatus?: unknown; driverVehicle?: unknown } | null | undefined,
  requireLegacyApproval: boolean,
): boolean {
  return !!user && (user.driverApprovalStatus === "approved" || (!requireLegacyApproval && !user.driverVehicle));
}
