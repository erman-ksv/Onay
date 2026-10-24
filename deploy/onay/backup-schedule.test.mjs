import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm, chmod, mkdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runScheduledBackup, backupStatus } from './backup-schedule.mjs';

async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'onay-schedule-unit-'));
  const config = { envFile: '/tmp/test.env', project: 'onay-unit', directory, keep: 2 };
  const dependencies = {
    create: async (args, file) => { await writeFile(file, 'PGDMPfixture', { mode: 0o600 }); return { bytes: 12, sha256: 'a'.repeat(64) }; },
    verify: async () => ({ restored: true, isolatedDatabase: true }),
  };
  try { await run(config, dependencies); } finally { await rm(directory, { recursive: true, force: true }); }
}
const archives = async dir => (await readdir(dir)).filter(name => name.endsWith('.dump'));

test('verified runs retain the newest two completed copies and leave unrelated files alone', async () => fixture(async (config, deps) => {
  await writeFile(join(config.directory, 'personal.dump'), 'do-not-touch');
  await runScheduledBackup(config, deps); await runScheduledBackup(config, deps); await runScheduledBackup(config, deps);
  assert.equal((await archives(config.directory)).length, 3);
  assert.equal(await readFile(join(config.directory, 'personal.dump'), 'utf8'), 'do-not-touch');
  assert.equal((await backupStatus(config.directory)).state, 'success');
}));

test('failed restore preserves previous copies and last successful timestamp', async () => fixture(async (config, deps) => {
  const successful = await runScheduledBackup(config, deps), before = await archives(config.directory);
  await assert.rejects(runScheduledBackup(config, { ...deps, verify: async () => { throw new Error('private-provider-detail'); } }), { message: 'BACKUP_SCHEDULE_FAILED' });
  for (const name of before) assert.ok((await archives(config.directory)).includes(name));
  const status = JSON.parse(await readFile(join(config.directory, 'status.json'), 'utf8'));
  assert.equal(status.state, 'failed'); assert.equal(status.lastSuccess, successful.lastSuccess);
  assert.ok(!JSON.stringify(status).includes('private-provider-detail'));
  await assert.rejects(backupStatus(config.directory), { message: 'BACKUP_MISSING_FAILED_OR_STALE' });
  assert.equal((await runScheduledBackup(config, deps)).state, 'success');
}));

test('an overlapping run cannot invoke backup or change the first run status', async () => fixture(async (config, deps) => {
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const first = runScheduledBackup(config, { ...deps, create: async (...args) => { entered(); await new Promise(resolve => { release = resolve; }); return deps.create(...args); } });
  await ready;
  try {
    await assert.rejects(runScheduledBackup(config, { create: () => assert.fail('overlapping backup started') }), { message: 'BACKUP_ALREADY_RUNNING_OR_STALE_LOCK' });
  } finally { release(); await first; }
}));

test('invalid retention and shared directories are refused before starting backup', async () => fixture(async (config, deps) => {
  for (const keep of [0, 1, 366, 2.5, NaN]) await assert.rejects(runScheduledBackup({ ...config, keep }, deps));
  await chmod(config.directory, 0o755);
  await assert.rejects(runScheduledBackup(config, deps), { message: 'BACKUP_DIRECTORY_MUST_BE_PRIVATE_AND_OWNED' });
}));

test('stale or missing archives fail monitoring even with a success status', async () => fixture(async (config, deps) => {
  const status = await runScheduledBackup(config, deps);
  await unlink(join(config.directory, status.archive));
  await assert.rejects(backupStatus(config.directory));
  await writeFile(join(config.directory, 'status.json'), JSON.stringify({ ...status, lastSuccess: '2000-01-01T00:00:00.000Z' }));
  await assert.rejects(backupStatus(config.directory), { message: 'BACKUP_MISSING_FAILED_OR_STALE' });
}));

test('unreadable status does not overwrite history and the lock is released', async () => fixture(async (config, deps) => {
  await writeFile(join(config.directory, 'status.json'), 'broken-json');
  await assert.rejects(runScheduledBackup(config, deps));
  assert.equal(await readFile(join(config.directory, 'status.json'), 'utf8'), 'broken-json');
  assert.ok(!(await readdir(config.directory)).includes('.onay-backup.lock'));
}));
