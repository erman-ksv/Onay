import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { open, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { randomBytes, createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// No shell, database URLs, row contents or child stderr are emitted.
async function docker(args, { inputFile, outputFile } = {}) {
  const child = spawn('docker', args, { stdio: [inputFile ? 'pipe' : 'ignore', outputFile ? 'pipe' : 'ignore', 'ignore'] });
  const timer = setTimeout(() => child.kill('SIGKILL'), 600000);
  const exited = new Promise((yes, no) => {
    child.once('error', () => no(new Error('BACKUP_DOCKER_UNAVAILABLE')));
    child.once('close', code => code === 0 ? yes() : no(new Error('BACKUP_COMMAND_FAILED')));
  });
  try {
    await Promise.all([exited,
      inputFile ? pipeline(createReadStream(inputFile), child.stdin) : Promise.resolve(),
      outputFile ? pipeline(child.stdout, createWriteStream(outputFile, { flags: 'r+', mode: 0o600 })) : Promise.resolve()]);
  } catch {
    child.kill('SIGKILL');
    throw new Error('BACKUP_COMMAND_FAILED');
  } finally { clearTimeout(timer); }
}

export function composeArgs(envFile, project) {
  if (!envFile || !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(project ?? '')) throw new Error('BACKUP_EXPLICIT_ENV_AND_PROJECT_REQUIRED');
  return ['compose', '-f', 'deploy/onay/compose.yaml', '--env-file', resolve(envFile), '-p', project];
}

export async function createBackup(args, filename) {
  const file = resolve(filename);
  // Exclusive creation prevents overwriting an existing backup or following a symlink.
  const handle = await open(file, 'wx', 0o600); await handle.close();
  try {
    await docker([...args, 'exec', '-T', 'db', 'pg_dump', '-U', 'onay', '-d', 'onay', '--format=custom', '--no-owner', '--no-acl'], { outputFile: file });
    const hash = createHash('sha256'); let bytes = 0;
    for await (const chunk of createReadStream(file)) { hash.update(chunk); bytes += chunk.length; }
    if (bytes < 5) throw new Error('BACKUP_EMPTY');
    return { bytes, sha256: hash.digest('hex') };
  } catch {
    await unlink(file);
    throw new Error('BACKUP_FAILED_INCOMPLETE_FILE_REMOVED');
  }
}

export async function verifyBackup(args, filename, { onRestored = async () => {} } = {}) {
  const file = resolve(filename);
  const handle = await open(file, 'r');
  try {
    const header = Buffer.alloc(5); const { bytesRead } = await handle.read(header, 0, 5, 0);
    if (bytesRead !== 5 || header.toString() !== 'PGDMP') throw new Error('BACKUP_NOT_CUSTOM_POSTGRES_ARCHIVE');
  } finally { await handle.close(); }
  const database = `onay_restore_${randomBytes(12).toString('hex')}`;
  let created = false;
  try {
    // This command never restores over onay or any caller-supplied database.
    await docker([...args, 'exec', '-T', 'db', 'createdb', '-U', 'onay', '--template=template0', database]); created = true;
    await docker([...args, 'exec', '-T', 'db', 'pg_restore', '-U', 'onay', '-d', database, '--exit-on-error', '--single-transaction', '--no-owner', '--no-acl'], { inputFile: file });
    await onRestored(database);
    return { restored: true, isolatedDatabase: true };
  } finally {
    if (created) await docker([...args, 'exec', '-T', 'db', 'dropdb', '-U', 'onay', '--force', database]);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [operation, envFile, project, file, ...extra] = process.argv.slice(2);
    if (!['create', 'verify'].includes(operation) || !file || extra.length) throw new Error('USAGE: backup.mjs create|verify ENV_FILE COMPOSE_PROJECT ARCHIVE');
    const args = composeArgs(envFile, project);
    console.log(JSON.stringify(operation === 'create' ? await createBackup(args, file) : await verifyBackup(args, file)));
  } catch (error) {
    // Filesystem errors can include paths; only emit our own safe reason codes.
    console.error(error.message?.startsWith('BACKUP_') || error.message?.startsWith('USAGE:') ? error.message : 'BACKUP_OPERATION_FAILED');
    process.exitCode = 1;
  }
}
