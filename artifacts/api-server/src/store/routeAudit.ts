import { randomUUID } from "node:crypto";
import type { AdminAuditEvent, RouteDefinition } from "../types/domain";

/** Only fixed metadata field names are retained; no names, stops or GPS values. */
export function routeMetadataEvent(before: RouteDefinition, after: RouteDefinition, actorId: string): AdminAuditEvent | undefined {
  const changedFields = (["name", "active", "pricePerStopKzt"] as const).filter(field => before[field] !== after[field]);
  if (!changedFields.length) return undefined;
  return { id: randomUUID(), actorId, action: "route.updated", routeId: after.id, changedFields,
    previousVersion: before.updatedAt, nextVersion: after.updatedAt, createdAt: new Date().toISOString() };
}
