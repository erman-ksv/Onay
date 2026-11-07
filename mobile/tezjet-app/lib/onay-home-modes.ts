export type OnayPassengerHomeMode = "city" | "village" | "address";
export type OnayPassengerHomeTarget = { section: "route" | "legacy"; direction: "a_to_b" | "b_to_a" | null };

/** Only maps presentation intent to an existing backend-backed booking form. */
export function onayPassengerHomeTarget(mode: OnayPassengerHomeMode): OnayPassengerHomeTarget {
  switch (mode) {
    case "city": return { section: "route", direction: "a_to_b" };
    case "village": return { section: "route", direction: "b_to_a" };
    case "address": return { section: "legacy", direction: null };
  }
}
