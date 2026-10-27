import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composeArgs, createBackup, verifyBackup } from './backup.mjs';

test('backup requires an explicit Compose environment and valid project', () => {
  for (const project of ['', undefined, '-p', 'onay;id', 'UPPER', 'x'.repeat(64)]) assert.throws(() => composeArgs('deploy/onay/.env', project));
  assert.throws(() => composeArgs('', 'onay-staging'));
  assert.deepEqual(composeArgs('/tmp/onay.env', 'onay-staging').slice(-4), ['--env-file', '/tmp/onay.env', '-p', 'onay-staging']);
});

test('backup refuses to overwrite a file or follow a destination symlink before Docker', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'onay-backup-unit-'));
  try {
    const file = join(folder, 'existing.dump'), link = join(folder, 'link.dump');
    await writeFile(file, 'keep-original'); await symlink(file, link);
    await assert.rejects(createBackup([], file), { code: 'EEXIST' });
    await assert.rejects(createBackup([], link), { code: 'EEXIST' });
    assert.equal(await readFile(file, 'utf8'), 'keep-original');
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('restore rejects empty or non-custom archives before creating a database', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'onay-backup-unit-'));
  try {
    const file = join(folder, 'invalid.dump');
    for (const contents of ['', 'PGDM', 'DROP DATABASE onay;']) {
      await writeFile(file, contents);
      await assert.rejects(verifyBackup([], file), { message: 'BACKUP_NOT_CUSTOM_POSTGRES_ARCHIVE' });
    }
  } finally { await rm(folder, { recursive: true, force: true }); }
});
