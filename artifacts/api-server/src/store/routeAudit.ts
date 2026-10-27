import { randomUUID } from "node:crypto";
import type { AdminAuditEvent, RouteDefinition } from "../types/domain";

/** Only fixed metadata field names are retained; no names, stops or GPS values. */
export function routeMetadataEvent(before: RouteDefinition, after: RouteDefinition, actorId: string): AdminAuditEvent | undefined {
  // Preserve the existing audit contract for KZT, while never labelling UZS
  // tariff changes with a KZT field name.
  const fields = before.currency === "UZS" ? ["name", "active", "pricePerStop"] as const : ["name", "active", "pricePerStopKzt"] as const;
  const changedFields = fields.filter(field => before[field] !== after[field]);
  if (!changedFields.length) return undefined;
  return { id: randomUUID(), actorId, action: "route.updated", routeId: after.id, changedFields,
    previousVersion: before.updatedAt, nextVersion: after.updatedAt, createdAt: new Date().toISOString() };
}
