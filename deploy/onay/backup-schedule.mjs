import { mkdir, lstat, readdir, readFile, writeFile, rename, unlink, rmdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { composeArgs, createBackup, verifyBackup } from './backup.mjs';

const archivePattern = /^onay-auto-\d{8}T\d{9}Z-[0-9a-f]{16}\.dump$/;
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
async function atomicJson(file, value) {
  const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(temporary, file);
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
async function readStatus(directory) {
  try {
    const value = JSON.parse(await readFile(join(directory, 'status.json'), 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('BACKUP_STATUS_UNREADABLE');
    return value;
  }
  catch (error) { if (error.code === 'ENOENT') return {}; throw new Error('BACKUP_STATUS_UNREADABLE'); }
}
async function privateDirectory(directory) {
  await mkdir(directory, { mode: 0o700, recursive: true });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) || (process.getuid && info.uid !== process.getuid()))
    throw new Error('BACKUP_DIRECTORY_MUST_BE_PRIVATE_AND_OWNED');
}

// Only our completed archive/manifest pairs are eligible for count retention.
async function prune(directory, keep, current) {
  const completed = [];
  for (const name of await readdir(directory)) {
    if (!archivePattern.test(name)) continue;
    const file = join(directory, name);
    try {
      const [info, metaInfo] = await Promise.all([lstat(file), lstat(`${file}.json`)]);
      if (!info.isFile() || !metaInfo.isFile()) continue;
      const meta = JSON.parse(await readFile(`${file}.json`, 'utf8'));
      if (meta.archive !== name || meta.verified !== true || !iso(meta.completedAt) || !/^[0-9a-f]{64}$/.test(meta.sha256) || info.size !== meta.bytes) continue;
      completed.push({ name, completedAt: meta.completedAt });
    } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  }
  // Always retain the archive verified by this run, even if the clock moves backwards.
  completed.sort((a, b) => a.name === current ? -1 : b.name === current ? 1 : Date.parse(b.completedAt) - Date.parse(a.completedAt) || b.name.localeCompare(a.name));
  let removed = 0;
  for (const entry of completed.slice(keep)) {
    await unlink(join(directory, entry.name));
    await unlink(join(directory, `${entry.name}.json`)); removed++;
  }
  return removed;
}

export async function runScheduledBackup(config, dependencies = {}) {
  const { envFile, project, directory, keep = 7 } = config;
  if (!directory || !Number.isInteger(keep) || keep < 2 || keep > 365) throw new Error('BACKUP_INVALID_SCHEDULE_CONFIG');
  const args = composeArgs(envFile, project), folder = resolve(directory);
  await privateDirectory(folder);
  const lock = join(folder, '.onay-backup.lock');
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('BACKUP_ALREADY_RUNNING_OR_STALE_LOCK'); throw error; }
  const create = dependencies.create ?? createBackup, verify = dependencies.verify ?? verifyBackup;
  let previous = {}, statusReadable = false;
  try {
    previous = await readStatus(folder); statusReadable = true;
    const startedAt = new Date().toISOString();
    const name = `onay-auto-${startedAt.replace(/[-:.]/g, '')}-${randomBytes(8).toString('hex')}.dump`;
    const file = join(folder, name);
    const metadata = await create(args, file);
    const result = await verify(args, file);
    if (result.restored !== true || result.isolatedDatabase !== true) throw new Error('BACKUP_RESTORE_VERIFICATION_FAILED');
    const completedAt = new Date().toISOString();
    await atomicJson(`${file}.json`, { archive: name, ...metadata, verified: true, completedAt });
    const removed = await prune(folder, keep, name);
    const status = { state: 'success', lastAttempt: startedAt, lastSuccess: completedAt, archive: name, removed };
    await atomicJson(join(folder, 'status.json'), status);
    return status;
  } catch {
    // Never prune after a failed backup/restore. Keep the last success timestamp.
    if (statusReadable) await atomicJson(join(folder, 'status.json'), {
      state: 'failed', lastAttempt: new Date().toISOString(), lastSuccess: previous.lastSuccess ?? null,
      reasonCode: 'SCHEDULED_BACKUP_FAILED',
    });
    throw new Error('BACKUP_SCHEDULE_FAILED');
  } finally { await rmdir(lock); }
}

export async function backupStatus(directory, maxAgeHours = 36) {
  if (!directory || !Number.isFinite(maxAgeHours) || maxAgeHours <= 0) throw new Error('BACKUP_INVALID_STATUS_CONFIG');
  const folder = resolve(directory), info = await lstat(folder);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077)) throw new Error('BACKUP_DIRECTORY_MUST_BE_PRIVATE_AND_OWNED');
  const status = await readStatus(folder), age = Date.now() - Date.parse(status.lastSuccess);
  if (status.state !== 'success' || !Number.isFinite(age) || age < -300000 || age > maxAgeHours * 3600000)
    throw new Error('BACKUP_MISSING_FAILED_OR_STALE');
  if (!archivePattern.test(status.archive ?? '')) throw new Error('BACKUP_STATUS_ARCHIVE_INVALID');
  const file = join(folder, status.archive), archive = await lstat(file), manifest = await lstat(`${file}.json`);
  if (!archive.isFile() || !manifest.isFile()) throw new Error('BACKUP_STATUS_ARCHIVE_INVALID');
  const metadata = JSON.parse(await readFile(`${file}.json`, 'utf8'));
  if (metadata.verified !== true || metadata.archive !== status.archive || metadata.completedAt !== status.lastSuccess || metadata.bytes !== archive.size)
    throw new Error('BACKUP_STATUS_ARCHIVE_INVALID');
  return { state: 'success', lastSuccess: status.lastSuccess, ageHours: Math.max(0, age / 3600000) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [operation, ...extra] = process.argv.slice(2);
    if (extra.length || !['run', 'status'].includes(operation)) throw new Error('BACKUP_USE_RUN_OR_STATUS');
    const env = process.env;
    const result = operation === 'run' ? await runScheduledBackup({ envFile: env.ONAY_BACKUP_ENV_FILE, project: env.ONAY_BACKUP_PROJECT,
      directory: env.ONAY_BACKUP_DIRECTORY, keep: Number(env.ONAY_BACKUP_KEEP ?? 7) }) : await backupStatus(env.ONAY_BACKUP_DIRECTORY, Number(env.ONAY_BACKUP_MAX_AGE_HOURS ?? 36));
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error.message?.startsWith('BACKUP_') ? error.message : 'BACKUP_SCHEDULE_OPERATION_FAILED'); process.exitCode = 1;
  }
}
