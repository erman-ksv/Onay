/** Driver-selected opt-in for collecting riders on a configured Onay line.
 * Never turn the legacy queue into line collection implicitly.
 */
export type DriverQueueMode = "legacy" | "line";
export type DriverLinePhase = "collecting" | "departed";

export function driverQueueJoinEndpoint(mode: DriverQueueMode, configuredRoute: boolean): string {
  if (mode === "line") {
    if (!configuredRoute) throw new Error("Сначала сохрани маршрут и направление A → B или B → A.");
    return "/api/queue/line";
  }
  if (mode !== "legacy") throw new Error("Неизвестный способ вступления в очередь.");
  return "/api/queue/join";
}

/** The server alone owns collection mode; never infer it from current UI selection. */
export function driverLinePhase(entry: unknown): DriverLinePhase | null {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const collection = (entry as Record<string, unknown>).collectionState;
  if (!collection || typeof collection !== "object" || Array.isArray(collection)) return null;
  const phase = collection as Record<string, unknown>;
  return phase.version === 1 && (phase.phase === "collecting" || phase.phase === "departed")
    ? phase.phase : null;
}

export function driverLineStatus(entry: unknown): string {
  const phase = driverLinePhase(entry);
  return phase === "collecting" ? "Набираем пассажиров. Отправление выполняется отдельным действием."
    : phase === "departed" ? "Линия отправилась."
    : "Обычная очередь.";
}
