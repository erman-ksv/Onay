/**
 * Visual tokens extracted from the user's ONAY Passenger V2 / Driver V2
 * Claude HTML artifacts. The mocks are reference designs, not API clients.
 */
export const onayDark = {
  background: "#0a1d15",
  card: "#12291f",
  cardRaised: "#17332a",
  border: "#1f3d2f",
  accent: "#5bd62f",
  accentInk: "#08261a",
  text: "#f2faf6",
  muted: "#9bb3a6",
  danger: "#ff9b8a",
  warning: "#ffc46b",
} as const;

export const ONAY_COUNTRY_CODE = "+998";

/** Keep the backend auth contract unchanged: +998 followed by nine digits. */
export function uzPhoneDigits(value: string): string {
  const digits = value.replace(/\D/g, "");
  return (digits.startsWith("998") && digits.length > 9 ? digits.slice(3) : digits).slice(0, 9);
}

export function toOnayApiPhone(value: string): string {
  const digits = uzPhoneDigits(value);
  return digits ? ONAY_COUNTRY_CODE + digits : "";
}

export function isCompleteOnayPhone(value: string): boolean {
  return /^\+998\d{9}$/.test(value);
}
