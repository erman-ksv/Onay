import { isIP } from 'node:net';
import { pathToFileURL } from 'node:url';
const invalid = field => { throw new Error(`INVALID_ONAY_STAGING_ENV:${field}`); };
export function verifyStagingEnvironment(env) {
  if (env.NODE_ENV !== 'production') invalid('NODE_ENV');
  if (env.TEZJET_STORAGE_ADAPTER !== 'postgres') invalid('TEZJET_STORAGE_ADAPTER');
  if (env.REQUIRE_DRIVER_APPROVAL !== 'true') invalid('REQUIRE_DRIVER_APPROVAL');
  const secret = env.SESSION_SECRET;
  if (typeof secret !== 'string' || secret.length < 32 || new Set(secret).size < 8 || /example|replace|change|development|your.secret/i.test(secret)) invalid('SESSION_SECRET');
  let database;
  try { database = new URL(env.DATABASE_URL); } catch { invalid('DATABASE_URL'); }
  if (!['postgres:', 'postgresql:'].includes(database.protocol) || !database.hostname || !database.username || database.pathname.length < 2) invalid('DATABASE_URL');
  let password;
  try { password = decodeURIComponent(database.password); } catch { invalid('DATABASE_URL'); }
  if (!/^[a-f0-9]{32,128}$/i.test(password) || new Set(password).size < 8 || password === secret) invalid('DATABASE_URL');
  const domain = env.ONAY_DOMAIN;
  if (typeof domain !== 'string' || domain.length > 253 || !domain.includes('.') || isIP(domain) ||
      domain.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) invalid('ONAY_DOMAIN');
  if (!/^\+[1-9]\d{7,14}$/.test(env.ADMIN_PHONE ?? '')) invalid('ADMIN_PHONE');
  if (!/^\d+$/.test(env.PORT ?? '') || Number(env.PORT) < 1 || Number(env.PORT) > 65535) invalid('PORT');
  return Object.freeze({ port: Number(env.PORT), domain });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { verifyStagingEnvironment(process.env); console.log('ONAY_STAGING_ENV_VALID'); }
  catch (error) { console.error(error.message); process.exitCode = 78; }
}
