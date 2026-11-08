/** A real profile's first character, matching the original Onay V2 mock avatar. */
export function onayProfileInitial(fullName: string): string {
  const first = Array.from(fullName.trim())[0];
  return first ? first.toLocaleUpperCase("ru") : "?";
}
