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

/** Presentation defaults to Uzbekistan; the backend also accepts other E.164 numbers. */
export function uzPhoneDigits(value: string): string {
  const digits = value.replace(/\D/g, "");
  return (digits.startsWith("998") ? digits.slice(3) : digits).slice(0, 9);
}

export function normalizeOnayPhone(value: string): string {
  const digits = value.replace(/\D/g, "").slice(0, 15);
  return digits ? "+" + digits : "";
}

export function toOnayApiPhone(value: string): string {
  if (value.trim().startsWith("+") && !value.trim().startsWith("+998")) {
    return normalizeOnayPhone(value);
  }
  const digits = uzPhoneDigits(value);
  return digits ? ONAY_COUNTRY_CODE + digits : "";
}

/** The displayed prefix tracks the country when pasting a full international number. */
export function onayPhonePrefix(value: string): string {
  return value.startsWith("+7") ? "+7" : ONAY_COUNTRY_CODE;
}

export function onayPhoneInput(value: string): string {
  const prefix = onayPhonePrefix(value);
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

export function onayPhoneFromInput(previous: string, next: string): string {
  return normalizeOnayPhone(next.trim().startsWith("+") ? next : onayPhonePrefix(previous) + next);
}

export function isCompleteOnayPhone(value: string): boolean {
  if (value.startsWith(ONAY_COUNTRY_CODE)) return /^\+998\d{9}$/.test(value);
  return /^\+[1-9]\d{9,14}$/.test(value);
}
