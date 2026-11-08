/** Email contact is not a login identity. Empty input clears the optional field. */
export function normalizeOnayContactEmail(value: string): string | null {
  const email = value.trim();
  if (!email) return null;
  if (email.length > 254 || !/^[^\s@]{1,64}@[^\s@.]+(?:\.[^\s@.]+)+$/.test(email)) {
    throw new Error("Проверь формат email");
  }
  return email.toLowerCase();
}
