export type DriverVehicle = { revision: string; make: string; model: string; plate_number: string; seat_capacity: number; updated_at: string };
export type DriverVehicleSnapshot = { driver_vehicle: DriverVehicle | null; approval_status: "pending" | "approved" | "rejected" | "blocked" };
export type VehicleDraft = { make: string; model: string; plate_number: string; seat_capacity: number };

export function parseDriverVehicleSnapshot(value: unknown): DriverVehicleSnapshot {
  const invalid = () => new Error("Не удалось подтвердить профиль автомобиля. Повтори обновление.");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const root = value as Record<string, unknown>;
  if (!["pending", "approved", "rejected", "blocked"].includes(root.approval_status as string)) throw invalid();
  if (root.driver_vehicle === null) return { driver_vehicle: null, approval_status: root.approval_status as DriverVehicleSnapshot["approval_status"] };
  if (!root.driver_vehicle || typeof root.driver_vehicle !== "object" || Array.isArray(root.driver_vehicle)) throw invalid();
  const raw = root.driver_vehicle as Record<string, unknown>;
  if (typeof raw.revision !== "string" || !raw.revision.trim() || typeof raw.make !== "string" || !raw.make.trim() ||
      typeof raw.model !== "string" || !raw.model.trim() || typeof raw.plate_number !== "string" || !raw.plate_number.trim() ||
      typeof raw.updated_at !== "string" || !Number.isFinite(Date.parse(raw.updated_at)) ||
      typeof raw.seat_capacity !== "number" || !Number.isSafeInteger(raw.seat_capacity) || raw.seat_capacity < 1 || raw.seat_capacity > 8) throw invalid();
  return { driver_vehicle: { revision: raw.revision, make: raw.make, model: raw.model, plate_number: raw.plate_number,
    seat_capacity: raw.seat_capacity, updated_at: raw.updated_at }, approval_status: root.approval_status as DriverVehicleSnapshot["approval_status"] };
}

export function driverVehicleBody(draft: VehicleDraft, current: DriverVehicle | null) {
  if (![draft.make, draft.model, draft.plate_number].every(value => typeof value === "string" && !!value.trim()) ||
      !Number.isSafeInteger(draft.seat_capacity) || draft.seat_capacity < 1 || draft.seat_capacity > 8) {
    throw new Error("Заполни марку, модель, госномер и количество пассажирских мест от 1 до 8.");
  }
  return { make: draft.make.trim(), model: draft.model.trim(), plate_number: draft.plate_number.trim(),
    seat_capacity: draft.seat_capacity, expected_revision: current?.revision ?? null };
}
