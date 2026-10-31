import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { before, after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

// Real production stores; private PostgreSQL schema, no external SMS transport.
const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const schema = `otp_delivery_${randomUUID().replaceAll('-', '')}`;
const applicationName = `otp-delivery-${randomUUID()}`;
const envNames = ['DATABASE_URL', 'NODE_ENV', 'SESSION_SECRET', 'LOG_LEVEL'];
const original = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
let directory, production, database, adminPool, store, otherStore, schemaCreated = false;
let sequence = 0;
before(async () => {
  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL required: OTP delivery identity tests must run real PostgreSQL.');
  const originalUrl = process.env.DATABASE_URL;
  const url = new URL(originalUrl);
  url.searchParams.set('options', `${url.searchParams.get('options') ?? ''} -c search_path=${schema}`.trim());
  url.searchParams.set('application_name', applicationName);
  process.env.DATABASE_URL = url.href;
  process.env.NODE_ENV = 'test';
  process.env.SESSION_SECRET = 'otp-delivery-identity-test-secret-at-least32';
  process.env.LOG_LEVEL = 'silent';
  directory = await mkdtemp(path.join(apiRoot, '.otp-delivery-test-'));
  const entry = path.join(directory, 'stores.mjs');
  await build({ stdin: { contents: [
    'export { PostgresStore } from "./src/store/postgresStore";',
    'export { MemoryStore } from "./src/store/memoryStore";',
    'export { pool } from "../../lib/db/src/index";',
    'export { otpRateKey } from "./src/store/otpProtection";',
    'export { OTP_LIMITS, OTP_TTL_MS } from "./src/utils/config";',
  ].join('\n'), resolveDir: apiRoot, loader: 'ts' }, outfile: entry,
    bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent', external: ['pg-native', 'pino'],
    banner: { js: 'import { createRequire as testRequire } from "node:module"; const require=testRequire(import.meta.url);' },
  });
  production = await import(pathToFileURL(entry).href);
  database = production.pool;
  adminPool = new database.constructor({ connectionString: originalUrl, max: 4 });
  await adminPool.query(`CREATE SCHEMA "${schema}"`); schemaCreated = true;
  for (const table of ['tezjet_offer_policy', 'tezjet_otp_challenges', 'otp_rate_limits', 'tezjet_routes']) {
    await adminPool.query(`CREATE TABLE "${schema}"."${table}" (LIKE public."${table}" INCLUDING ALL)`);
  }
  store = new production.PostgresStore(); otherStore = new production.PostgresStore();
  await Promise.all([store.initialize(), otherStore.initialize()]);
}, { timeout: 30_000 });
after(async () => {
  try {
    if (database) await database.end();
    if (schemaCreated) await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
  } finally {
    if (adminPool) await adminPool.end();
    if (directory) await rm(directory, { recursive: true, force: true });
    for (const name of envNames) original[name] === undefined ? delete process.env[name] : process.env[name] = original[name];
  }
});
function phone() { return '+99890' + String(++sequence).padStart(7, '0'); }
function challenge(number, deliveryId = randomUUID()) {
  return { phoneNumber: number, code: '684291', role: 'passenger', locale: 'ru', fullName: 'Delivery test', expiresAt: Date.now() + production.OTP_TTL_MS,
    ...(deliveryId === null ? {} : { deliveryId }) };
}
async function eligibleAgain(number) {
  const key = production.otpRateKey('send', number);
  await database.query("UPDATE otp_rate_limits SET state=jsonb_set(state,'{nextAllowedAt}','0'::jsonb) WHERE key=$1", [key]);
}
async function pair(t, body) {
  for (const [name, adapter] of [['memory', new production.MemoryStore()], ['postgres', store]]) {
    await t.test(name, async child => {
      let now = Date.now();
      if (name === 'memory') child.mock.method(Date, 'now', () => now);
      const later = async number => name === 'memory' ? now += production.OTP_LIMITS.resendCooldownMs + 1 : eligibleAgain(number);
      await body(adapter, later);
    });
  }
}

test('delivery rejection deletes only its own challenge and never refunds phone cooldown', async t => pair(t, async adapter => {
  const number = phone(), first = challenge(number);
  assert.equal((await adapter.saveOtpProtected(first)).allowed, true);
  assert.equal(await adapter.discardOtpDelivery(number, first.deliveryId), true);
  assert.equal(await adapter.discardOtpDelivery(number, first.deliveryId), false);
  assert.equal((await adapter.saveOtpProtected(challenge(number))).allowed, false, 'Failed delivery still consumed send admission.');
  assert.equal((await adapter.consumeOtpProtected(number, first.code)).status, 'invalid');
}));

test('same-code replacement with new identity survives late cleanup and consumes exactly once', async t => pair(t, async (adapter, later) => {
  const number = phone(), old = challenge(number), fresh = challenge(number);
  assert.equal(old.code, fresh.code);
  assert.equal((await adapter.saveOtpProtected(old)).allowed, true);
  await later(number);
  assert.equal((await adapter.saveOtpProtected(fresh)).allowed, true);
  assert.equal(await adapter.discardOtpDelivery(number, old.deliveryId), false);
  const result = await adapter.consumeOtpProtected(number, fresh.code);
  assert.equal(result.status, 'verified'); assert.equal(result.challenge.deliveryId, fresh.deliveryId);
  assert.equal((await adapter.consumeOtpProtected(number, fresh.code)).status, 'invalid');
  assert.equal(await adapter.discardOtpDelivery(number, fresh.deliveryId), false);
}));

test('cleanup is scoped by normalized phone and identity; malformed and legacy IDs never delete', async t => pair(t, async adapter => {
  const one = phone(), two = phone(), common = randomUUID();
  await adapter.saveOtpProtected(challenge(one, common)); await adapter.saveOtpProtected(challenge(two, common));
  assert.equal(await adapter.discardOtpDelivery(one, randomUUID()), false);
  assert.equal(await adapter.discardOtpDelivery(one, ''), false);
  assert.equal(await adapter.discardOtpDelivery(one, 'not-an-identity'), false);
  const formatted = one.replace(/^\+998(\d{2})(\d{7})$/, '+998 ($1) $2');
  assert.equal(await adapter.discardOtpDelivery(formatted, common), true);
  assert.equal((await adapter.consumeOtpProtected(two, '684291')).status, 'verified');
  const legacy = phone(); await adapter.saveOtpProtected(challenge(legacy, null));
  assert.equal(await adapter.discardOtpDelivery(legacy, common), false);
  const result = await adapter.consumeOtpProtected(legacy, '684291');
  assert.equal(result.status, 'verified'); assert.equal(Object.hasOwn(result.challenge, 'deliveryId'), false);
}));

test('trusted and protected replacement clear old identities when the replacement is legacy', async t => pair(t, async (adapter, later) => {
  const trusted = phone(), old = challenge(trusted);
  await adapter.saveOtp(old); await adapter.saveOtp({ ...challenge(trusted, null), deliveryId: undefined });
  assert.equal(await adapter.discardOtpDelivery(trusted, old.deliveryId), false);
  assert.equal(Object.hasOwn(await adapter.consumeOtp(trusted, old.code), 'deliveryId'), false);
  const protectedPhone = phone(), first = challenge(protectedPhone);
  await adapter.saveOtpProtected(first); await later(protectedPhone);
  await adapter.saveOtpProtected(challenge(protectedPhone, null));
  assert.equal(await adapter.discardOtpDelivery(protectedPhone, first.deliveryId), false);
  const result = await adapter.consumeOtpProtected(protectedPhone, first.code);
  assert.equal(result.status, 'verified'); assert.equal(Object.hasOwn(result.challenge, 'deliveryId'), false);
}));

test('cleanup retains all existing send and verification budget state', async () => {
  const number = phone(), first = challenge(number);
  await store.saveOtpProtected(first);
  await store.consumeOtpProtected(number, '000000');
  const keys = ['send', 'verify'].map(kind => production.otpRateKey(kind, number));
  const before = (await database.query('SELECT key,state,expires_at FROM otp_rate_limits WHERE key=ANY($1::text[]) ORDER BY key', [keys])).rows;
  assert.equal(await otherStore.discardOtpDelivery(number, first.deliveryId), true);
  const after = (await database.query('SELECT key,state,expires_at FROM otp_rate_limits WHERE key=ANY($1::text[]) ORDER BY key', [keys])).rows;
  assert.deepEqual(after, before);
});

async function blocked(count) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const result = await adminPool.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND application_name=$1 AND wait_event_type='Lock'", [applicationName]);
    if (result.rows[0].count >= count) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Expected ${count} real PostgreSQL lock waiters`);
}
async function lockPhone(number) {
  const client = await adminPool.connect();
  await client.query('BEGIN');
  const keys = ['send', 'verify'].map(kind => production.otpRateKey(kind, number)).sort();
  await client.query(`SELECT key FROM "${schema}".otp_rate_limits WHERE key=ANY($1::text[]) ORDER BY key FOR UPDATE`, [keys]);
  return client;
}
const outcome = promise => promise.then(value => ({ value }), error => ({ error }));

test('real lock wait serializes newer protected save before late cleanup, preserving identical-code replacement', { timeout: 15_000 }, async () => {
  const number = phone(), old = challenge(number), fresh = challenge(number);
  await store.saveOtpProtected(old); await eligibleAgain(number);
  const blocker = await lockPhone(number); const pending = [];
  try {
    const saving = outcome(store.saveOtpProtected(fresh)); pending.push(saving); await blocked(1);
    const clearing = outcome(otherStore.discardOtpDelivery(number, old.deliveryId)); pending.push(clearing); await blocked(2);
    await blocker.query('COMMIT');
    assert.deepEqual(await saving, { value: { allowed: true } });
    assert.deepEqual(await clearing, { value: false });
    const verified = await otherStore.consumeOtpProtected(number, fresh.code);
    assert.equal(verified.status, 'verified'); assert.equal(verified.challenge.deliveryId, fresh.deliveryId);
  } finally { await blocker.query('ROLLBACK'); blocker.release(); await Promise.all(pending); }
});

test('real lock wait serializes valid consume before cleanup without a second deletion', { timeout: 15_000 }, async () => {
  const number = phone(), first = challenge(number);
  await store.saveOtpProtected(first);
  const blocker = await lockPhone(number); const pending = [];
  try {
    const consuming = outcome(store.consumeOtpProtected(number, first.code)); pending.push(consuming); await blocked(1);
    const clearing = outcome(otherStore.discardOtpDelivery(number, first.deliveryId)); pending.push(clearing); await blocked(2);
    await blocker.query('COMMIT');
    const result = await consuming; assert.equal(result.error, undefined); assert.equal(result.value.status, 'verified');
    assert.equal(result.value.challenge.deliveryId, first.deliveryId);
    assert.deepEqual(await clearing, { value: false });
    assert.equal((await store.consumeOtpProtected(number, first.code)).status, 'invalid');
  } finally { await blocker.query('ROLLBACK'); blocker.release(); await Promise.all(pending); }
});

test('actual0014 migration is repeatable and preserves every legacy challenge value', async () => {
  const migrationSchema = `otp_delivery_migration_${randomUUID().replaceAll('-', '')}`;
  const client = await adminPool.connect();
  const migration = await readFile(path.resolve(apiRoot, '../../lib/db/drizzle/0014_otp_delivery_identity.sql'), 'utf8');
  try {
    await client.query('BEGIN'); await client.query(`CREATE SCHEMA "${migrationSchema}"`);
    await client.query(`SET LOCAL search_path TO "${migrationSchema}"`);
    await client.query('CREATE TABLE tezjet_otp_challenges(phone_number text PRIMARY KEY,code text NOT NULL,role text NOT NULL,locale text NOT NULL,full_name text,expires_at bigint NOT NULL)');
    await client.query("INSERT INTO tezjet_otp_challenges VALUES('+998900000001','legacy-hash','passenger','uz',NULL,123456789)");
    const before = (await client.query('SELECT * FROM tezjet_otp_challenges')).rows[0];
    await client.query(migration); await client.query(migration);
    const after = (await client.query('SELECT * FROM tezjet_otp_challenges')).rows[0];
    assert.equal(after.delivery_id, null); delete after.delivery_id; assert.deepEqual(after, before);
  } finally { await client.query('ROLLBACK'); client.release(); }
});
