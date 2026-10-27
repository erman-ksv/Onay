import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verifyStagingEnvironment } from './verify-env.mjs';
const fixture = () => ({ NODE_ENV: 'production', TEZJET_STORAGE_ADAPTER: 'postgres', REQUIRE_DRIVER_APPROVAL: 'true', PORT: '8080',
  SESSION_SECRET: randomBytes(32).toString('hex'), DATABASE_URL: `postgresql://onay:${randomBytes(32).toString('hex')}@db:5432/onay`,
  ONAY_DOMAIN: 'api.onay.test', ADMIN_PHONE: '+15555550100' });
test('valid staging configuration exposes only non-secret metadata', () => {
  const env = fixture(), result = verifyStagingEnvironment(env);
  assert.deepEqual(result, { port: 8080, domain: 'api.onay.test' }); assert.ok(Object.isFrozen(result));
  assert.ok(!JSON.stringify(result).includes(env.SESSION_SECRET));
});
test('missing deployment inputs stop before startup', async t => {
  for (const key of Object.keys(fixture())) await t.test(key, () => { const env = fixture(); delete env[key]; assert.throws(() => verifyStagingEnvironment(env), { message: `INVALID_ONAY_STAGING_ENV:${key}` }); });
});
test('development, memory and approval bypass cannot start this staging recipe', () => {
  for (const patch of [{ NODE_ENV: 'development' }, { TEZJET_STORAGE_ADAPTER: 'memory' }, { REQUIRE_DRIVER_APPROVAL: 'false' }])
    assert.throws(() => verifyStagingEnvironment({ ...fixture(), ...patch }));
});
test('weak, placeholder or reused credentials produce only safe field diagnostics', () => {
  for (const value of ['short', 'a'.repeat(64), 'replace-this-development-secret-123456789']) assert.throws(() => verifyStagingEnvironment({ ...fixture(), SESSION_SECRET: value }));
  const env = fixture(); env.DATABASE_URL = `postgresql://onay:${env.SESSION_SECRET}@db/onay`;
  assert.throws(() => verifyStagingEnvironment(env), { message: 'INVALID_ONAY_STAGING_ENV:DATABASE_URL' });
  for (const value of ['https://private-user:private-password@db/onay', 'postgresql://onay:weak-private-password@db/onay', 'private-invalid-url'])
    assert.throws(() => verifyStagingEnvironment({ ...fixture(), DATABASE_URL: value }), { message: 'INVALID_ONAY_STAGING_ENV:DATABASE_URL' });
});
test('invalid endpoints, administrative phone and ports are refused', () => {
  for (const domain of ['localhost', '127.0.0.1', 'https://api.onay.test', 'bad domain.test', '-bad.test', 'api..test', 'a'.repeat(64)+'.test'])
    assert.throws(() => verifyStagingEnvironment({ ...fixture(), ONAY_DOMAIN: domain }));
  for (const port of ['0', '65536', '8080evil', '-1']) assert.throws(() => verifyStagingEnvironment({ ...fixture(), PORT: port }));
  assert.throws(() => verifyStagingEnvironment({ ...fixture(), ADMIN_PHONE: 'not-a-phone' }));
});
test('entrypoint refuses invalid configuration without executing its command or leaking credentials', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./entrypoint.mjs', import.meta.url)), process.execPath, '-e', 'console.log("UNAUTHORIZED_CHILD_EXECUTION")'],
    { env: { ...fixture(), DATABASE_URL: 'private-invalid-url', PATH: process.env.PATH }, encoding: 'utf8' });
  assert.equal(result.status, 78); assert.ok(!result.stdout.includes('UNAUTHORIZED_CHILD_EXECUTION'));
  assert.ok(!result.stderr.includes('private-invalid-url')); assert.match(result.stderr, /INVALID_ONAY_STAGING_ENV:DATABASE_URL/);
});

test('destructive smoke cleanup is unreachable outside an isolated CI runner', async () => {
  const { runStagingSmoke } = await import('./smoke.mjs');
  for (const env of [{}, { CI: 'true' }, { GITHUB_ACTIONS: 'true' }, { CI: 'false', GITHUB_ACTIONS: 'true' }])
    await assert.rejects(runStagingSmoke(env), { message: 'ONAY_SMOKE_REQUIRES_ISOLATED_GITHUB_RUNNER' });
});
