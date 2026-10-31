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

test('actual upgrade through0015 adds policy without changing live deadlines or audit history', { timeout: 30000 }, async t => {
  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL is required for a real migration upgrade');
  const schema = `offer_policy_upgrade_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.set('options', `${url.searchParams.get('options') ?? ''} -c search_path=${schema}`.trim());
  const pool = new Pool({ connectionString: url.href, max: 2 });
  const oldFolder = await mkdtemp(path.join(tmpdir(), 'onay-offer-policy-upgrade-'));
  let created = false;
  t.after(async () => { try { await pool.end(); if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`); }
    finally { await admin.end(); await rm(oldFolder, { recursive: true, force: true }); } });
  const journal = JSON.parse(await readFile(path.join(migrationsFolder, 'meta/_journal.json'), 'utf8'));
  const old = { ...journal, entries: journal.entries.filter(entry => entry.idx <= 15) };
  const addition = journal.entries.find(entry => entry.tag === '0016_offer_timeout_policy');
  assert.ok(addition && addition.when > Math.max(...old.entries.map(entry => entry.when)));
  await mkdir(path.join(oldFolder, 'meta'));
  await writeFile(path.join(oldFolder, 'meta/_journal.json'), JSON.stringify(old));
  for (const entry of old.entries) await copyFile(path.join(migrationsFolder, entry.tag + '.sql'), path.join(oldFolder, entry.tag + '.sql'));
  await admin.query(`CREATE SCHEMA "${schema}"`); created = true;
  const db = drizzle(pool), options = folder => ({ migrationsFolder: folder, migrationsSchema: schema, migrationsTable: '__drizzle_migrations' });
  await migrate(db, options(oldFolder));
  const orderId = randomUUID(), timestamp = '2026-10-31T10:00:00.000Z';
  await pool.query(`INSERT INTO tezjet_orders(id,passenger_id,status,created_at,updated_at,payload)
    VALUES($1,$2,'searching',$3,$3,$4::jsonb)`, [orderId, randomUUID(), timestamp,
      JSON.stringify({ offerExpiresAt: '2026-10-31T10:01:00.000Z', seats: 2, sentinel: 'live-offer' })]);
  const eventId = randomUUID();
  await pool.query(`INSERT INTO tezjet_admin_audit_events(id,actor_id,action,order_id,from_status,to_status,created_at)
    VALUES($1,$2,'order.cancelled',$3,'searching','cancelled',$4)`, [eventId, randomUUID(), randomUUID(), timestamp]);
  const beforeOrder = (await pool.query('SELECT * FROM tezjet_orders WHERE id=$1', [orderId])).rows[0];
  const beforeAudit = (await pool.query('SELECT * FROM tezjet_admin_audit_events WHERE id=$1', [eventId])).rows[0];
  const beforeHistory = (await pool.query('SELECT * FROM __drizzle_migrations ORDER BY id')).rows;
  await migrate(db, options(migrationsFolder));
  const history = (await pool.query('SELECT * FROM __drizzle_migrations ORDER BY id')).rows;
  assert.deepEqual(history.slice(0, beforeHistory.length), beforeHistory);
  assert.equal(history.length, beforeHistory.length + 1);
  assert.equal(Number(history.at(-1).created_at), addition.when);
  assert.deepEqual((await pool.query('SELECT * FROM tezjet_orders WHERE id=$1', [orderId])).rows[0], beforeOrder);
  assert.deepEqual((await pool.query('SELECT * FROM tezjet_admin_audit_events WHERE id=$1', [eventId])).rows[0],
    { ...beforeAudit, setting_key: null, previous_value: null, next_value: null });
  assert.deepEqual((await pool.query('SELECT * FROM tezjet_offer_policy')).rows, [{ id: 'offer-timeout', seconds: null, revision: null, updated_at: null }]);
  for (const invalid of [0, 3601]) await assert.rejects(pool.query("UPDATE tezjet_offer_policy SET seconds=$1,revision='receipt',updated_at=$2", [invalid, timestamp]), error => error.code === '23514');
  await assert.rejects(pool.query("UPDATE tezjet_offer_policy SET seconds=60"), error => error.code === '23514');
  await assert.rejects(pool.query("INSERT INTO tezjet_offer_policy(id) VALUES('other')"), error => error.code === '23514');
  await assert.rejects(pool.query(`INSERT INTO tezjet_admin_audit_events(id,actor_id,action,created_at)
    VALUES($1,$2,'settings.offer_timeout_changed',$3)`, [randomUUID(), randomUUID(), timestamp]), error => error.code === '23514');
  await assert.rejects(pool.query('DELETE FROM tezjet_admin_audit_events WHERE id=$1', [eventId]), error => error.code === '55000');
  await pool.query("UPDATE tezjet_offer_policy SET seconds=75,revision='durable-receipt',updated_at=$1", [timestamp]);
  const saved = (await pool.query('SELECT * FROM tezjet_offer_policy')).rows;
  await migrate(db, options(migrationsFolder));
  assert.deepEqual((await pool.query('SELECT * FROM tezjet_offer_policy')).rows, saved);
  assert.deepEqual((await pool.query('SELECT * FROM __drizzle_migrations ORDER BY id')).rows, history);
  assert.deepEqual((await pool.query('SELECT * FROM tezjet_orders WHERE id=$1', [orderId])).rows[0], beforeOrder);
});
