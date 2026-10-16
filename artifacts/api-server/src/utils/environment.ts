/**
 * Onay settings take precedence even when explicitly empty. Legacy names remain
 * readable for existing deployments; callers retain their normal validation.
 */
export function getOnayEnv(suffix: string): string | undefined {
  return process.env[`ONAY_${suffix}`] ?? process.env[`TEZJET_${suffix}`];
}
