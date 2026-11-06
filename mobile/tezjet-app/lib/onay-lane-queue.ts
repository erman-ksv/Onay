export type OnayLaneRow = { driverId: string; position: number; availableSeats: number };
/** Project only existing public queue fields, never GPS or passenger data. */
export function parseOnayLaneQueue(value: unknown): OnayLaneRow[] {
 const data = value as { queue?: unknown } | null;
 if (!data || !Array.isArray(data.queue) || data.queue.length > 5000) throw new Error("Не удалось подтвердить очередь.");
 const seen = new Set<string>();
 return data.queue.map(item => {
  if (!item || typeof item !== "object" || typeof item.driverId !== "string" || !item.driverId || seen.has(item.driverId) || !Number.isSafeInteger(item.position) || item.position < 1 || !Number.isSafeInteger(item.availableSeats) || item.availableSeats < 0 || item.availableSeats > 8) throw new Error("Не удалось подтвердить очередь.");
  seen.add(item.driverId);
  return { driverId: item.driverId, position: item.position, availableSeats: item.availableSeats };
 }).sort((a,b) => a.position - b.position);
}
