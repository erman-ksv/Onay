/** Keep the auth API contract as a single full_name field. */
export const MAX_REGISTRATION_FULL_NAME_LENGTH = 120;

export function normalizeRegistrationNamePart(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function registrationFullName(givenName: string, familyName: string): string | null {
  const first = normalizeRegistrationNamePart(givenName);
  const last = normalizeRegistrationNamePart(familyName);
  if (!first || !last) return null;

  const fullName = `${first} ${last}`;
  return fullName.length <= MAX_REGISTRATION_FULL_NAME_LENGTH ? fullName : null;
}
