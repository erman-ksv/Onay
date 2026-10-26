import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dbRoot = path.resolve(apiRoot, '../../lib/db');
const migrationsFolder = path.join(dbRoot, 'drizzle');
const { Pool } = createRequire(path.join(dbRoot, 'package.json'))('pg');

// Exercise the real Drizzle timestamp comparison. A fresh migration run alone
// cannot detect an older-timestamp migration skipped by an existing database.
test('an actual Drizzle upgrade from applied0012 repairs skipped0013 without rewriting saved bookings', { timeout: 30_000 }, async t => {
  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL is required: the route-fence upgrade must execute real PostgreSQL and the actual migrator.');
  const schema = `route_fence_upgrade_${randomUUID().replaceAll('-', '')}`;
  const originalUrl = process.env.DATABASE_URL;
  const admin = new Pool({ connectionString: originalUrl, max: 2 });
  const isolatedUrl = new URL(originalUrl);
  isolatedUrl.searchParams.set('options', `${isolatedUrl.searchParams.get('options') ?? ''} -c search_path=${schema}`.trim());
  const pool = new Pool({ connectionString: isolatedUrl.href, max: 2 });
  const oldFolder = await mkdtemp(path.join(tmpdir(), 'onay-route-fence-upgrade-'));
  let schemaCreated = false;
  t.after(async () => {
    try {
      await pool.end();
      if (schemaCreated) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      await admin.end();
      await rm(oldFolder, { recursive: true, force: true });
    }
  });
  const journal = JSON.parse(await readFile(path.join(migrationsFolder, 'meta/_journal.json'), 'utf8'));
  const through12 = { ...journal, entries: journal.entries.filter(entry => entry.idx <= 12) };
  const twelve = journal.entries.find(entry => entry.idx === 12);
  const thirteen = journal.entries.find(entry => entry.idx === 13);
  const repair = journal.entries.find(entry => entry.tag === '0015_route_request_fence_repair');
  assert.ok(twelve && thirteen && repair, 'The historical boundary and new repair must remain in the committed journal.');
  assert.ok(thirteen.when < twelve.when, 'Reproduce the existing timestamp hazard rather than silently rewriting historical entries.');
  assert.ok(repair.when > Math.max(...journal.entries.filter(entry => entry.idx < repair.idx).map(entry => entry.when)), 'The repair must be newer than every preceding migration, including already-applied0014.');
  await mkdir(path.join(oldFolder, 'meta'));
  await writeFile(path.join(oldFolder, 'meta/_journal.json'), JSON.stringify(through12));
  for (const entry of through12.entries) await copyFile(path.join(migrationsFolder, entry.tag + '.sql'), path.join(oldFolder, entry.tag + '.sql'));

  await admin.query(`CREATE SCHEMA "${schema}"`); schemaCreated = true;
  const db = drizzle(pool);
  const options = folder => ({ migrationsFolder: folder, migrationsSchema: schema, migrationsTable: '__drizzle_migrations' });
  await migrate(db, options(oldFolder));
  assert.equal((await pool.query('SELECT max(created_at)::text AS latest FROM __drizzle_migrations')).rows[0].latest, String(twelve.when));
  assert.equal((await pool.query("SELECT to_regclass('tezjet_closed_route_order_requests')::text AS name")).rows[0].name, null, 'The database at0012 must not already contain the missing fence.');

  const passenger = randomUUID(), orderId = randomUUID(), receiptKey = randomUUID();
  const timestamp = '2026-10-25T00:00:00.000Z';
  await pool.query(`INSERT INTO tezjet_orders(id,passenger_id,status,created_at,updated_at,payload) VALUES($1,$2,'searching',$3,$3,$4::jsonb)`,
    [orderId, passenger, timestamp, JSON.stringify({ sentinel: 'existing-order', seats: 2, currency: 'UZS', total: 7000 })]);
  await pool.query('INSERT INTO tezjet_route_order_requests(passenger_id,request_key,request_hash,order_id,created_at) VALUES($1,$2,$3,$4,$5)',
    [passenger, receiptKey, 'a'.repeat(64), orderId, timestamp]);
  const savedOrder = (await pool.query('SELECT * FROM tezjet_orders WHERE id=$1', [orderId])).rows[0];
  const savedReceipt = (await pool.query('SELECT * FROM tezjet_route_order_requests WHERE passenger_id=$1 AND request_key=$2', [passenger, receiptKey])).rows[0];
  const historyBefore = (await pool.query('SELECT * FROM __drizzle_migrations ORDER BY id')).rows;

  await migrate(db, options(migrationsFolder));
  const historyAfter = (await pool.query('SELECT * FROM __drizzle_migrations ORDER BY id')).rows;
  assert.deepEqual(historyAfter.slice(0, historyBefore.length), historyBefore, 'Previously applied migration records must remain byte-for-byte equivalent.');
  assert.equal(historyAfter.some(row => Number(row.created_at) === thirteen.when), false, 'Actual Drizzle skipped historical0013 because its timestamp is below applied0012.');
  assert.equal(historyAfter.some(row => Number(row.created_at) === repair.when), true, 'The new repair must be applied by the actual migrator.');
  assert.deepEqual((await pool.query('SELECT * FROM tezjet_orders WHERE id=$1', [orderId])).rows[0], savedOrder);
  assert.deepEqual((await pool.query('SELECT * FROM tezjet_route_order_requests WHERE passenger_id=$1 AND request_key=$2', [passenger, receiptKey])).rows[0], savedReceipt);
  assert.equal((await pool.query("SELECT to_regclass('tezjet_closed_route_order_requests')::text AS name")).rows[0].name, 'tezjet_closed_route_order_requests');
  const triggers = (await pool.query(`SELECT t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND NOT t.tgisinternal AND t.tgname IN ('tezjet_route_request_fence_receipt','tezjet_route_request_fence_closed') ORDER BY t.tgname`, [schema])).rows.map(row => row.tgname);
  assert.deepEqual(triggers, ['tezjet_route_request_fence_closed', 'tezjet_route_request_fence_receipt']);
  const indices = (await pool.query(`SELECT indexname FROM pg_indexes WHERE schemaname=$1 AND tablename='tezjet_closed_route_order_requests' ORDER BY indexname`, [schema])).rows.map(row => row.indexname);
  assert.deepEqual(indices, ['tezjet_closed_route_requests_passenger_key_uq', 'tezjet_closed_route_requests_passenger_time_idx']);

  await assert.rejects(pool.query('INSERT INTO tezjet_closed_route_order_requests(passenger_id,request_key,closed_at) VALUES($1,$2,$3)',
    [passenger, receiptKey, timestamp]), error => error.code === '23514');
  const closedKey = randomUUID();
  await pool.query('INSERT INTO tezjet_closed_route_order_requests(passenger_id,request_key,closed_at) VALUES($1,$2,$3)', [passenger, closedKey, timestamp]);
  await assert.rejects(pool.query('INSERT INTO tezjet_route_order_requests(passenger_id,request_key,request_hash,order_id,created_at) VALUES($1,$2,$3,$4,$5)',
    [passenger, closedKey, 'b'.repeat(64), randomUUID(), timestamp]), error => error.code === '23514');
  const savedClosed = (await pool.query('SELECT * FROM tezjet_closed_route_order_requests WHERE passenger_id=$1 AND request_key=$2', [passenger, closedKey])).rows[0];
  await migrate(db, options(migrationsFolder));
  assert.deepEqual((await pool.query('SELECT * FROM __drizzle_migrations ORDER BY id')).rows, historyAfter, 'Repeating the real migration runner must not reapply or mutate history.');
  // Re-running the repair SQL itself also preserves permanent identities.
  await pool.query(await readFile(path.join(migrationsFolder, repair.tag + '.sql'), 'utf8'));
  assert.deepEqual((await pool.query('SELECT * FROM tezjet_closed_route_order_requests WHERE passenger_id=$1 AND request_key=$2', [passenger, closedKey])).rows[0], savedClosed);
  assert.deepEqual((await pool.query('SELECT * FROM tezjet_orders WHERE id=$1', [orderId])).rows[0], savedOrder);
  assert.deepEqual((await pool.query('SELECT * FROM tezjet_route_order_requests WHERE passenger_id=$1 AND request_key=$2', [passenger, receiptKey])).rows[0], savedReceipt);
});
