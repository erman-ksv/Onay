/** Bottom navigation follows the four pages of ONAY Passenger V2. */
export const ONAY_PASSENGER_TABS = [
  { id: "home", label: "Главная", symbol: "⌂" },
  { id: "trips", label: "Поездки", symbol: "▤" },
  { id: "chats", label: "Чаты", symbol: "✉" },
  { id: "profile", label: "Профиль", symbol: "♙" },
] as const;
export type OnayPassengerTab = (typeof ONAY_PASSENGER_TABS)[number]["id"];

/** Tabs only navigate within the mounted passenger view, never create orders. */
export function onayPassengerTabScrollY(tab: OnayPassengerTab, anchors: {
  trips: number; chats: number; profile: number;
}): number {
  return tab === "home" ? 0 : Math.max(0, anchors[tab] - 12);
}
