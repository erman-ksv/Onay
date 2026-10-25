import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, statSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBackup, verifyBackup } from './backup.mjs';
import { runScheduledBackup, backupStatus } from './backup-schedule.mjs';

export async function runStagingSmoke(env = process.env) {
  if (env.CI !== 'true' || env.GITHUB_ACTIONS !== 'true') throw new Error('ONAY_SMOKE_REQUIRES_ISOLATED_GITHUB_RUNNER');
  const temporary = mkdtempSync(join(tmpdir(), 'onay-staging-'));
  const identifier = randomBytes(6).toString('hex'), project = `onay-smoke-${identifier}`;
  const password = randomBytes(32).toString('hex'), secret = randomBytes(32).toString('hex');
  const envFile = join(temporary, 'staging.env');
  writeFileSync(envFile, `POSTGRES_PASSWORD=${password}\nSESSION_SECRET=${secret}\nONAY_DOMAIN=api.onay.test\nACME_EMAIL=ci@example.test\nADMIN_PHONE=+15555550100\nONAY_IMAGE_TAG=${identifier}\n`, { mode: 0o600 });
  const args = ['compose', '-f', 'deploy/onay/compose.yaml', '--env-file', envFile, '-p', project];
  const report = { status: 'running', checks: [], realServerDeployed: false, publicHttpsVerified: false, smsDeliveryVerified: false };
  const output = resolve('artifacts/staging-runtime'); mkdirSync(output, { recursive: true });
  const save = () => writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  const redact = text => String(text ?? '').replaceAll(password, '[REDACTED]').replaceAll(secret, '[REDACTED]');
  function command(parts, { input, expected = 0, timeout = 180000 } = {}) {
    const result = spawnSync('docker', [...args, ...parts], { input, encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024, env });
    if (result.status !== expected || result.error) {
      console.error(redact((result.stdout ?? '') + (result.stderr ?? '')).slice(-12000));
      throw new Error('ONAY_STAGING_SMOKE_COMMAND_FAILED');
    }
    return result.stdout;
  }
  function check(name, run) { console.log(JSON.stringify({ event: 'staging_check', name, status: 'running' })); run(); report.checks.push({ name, status: 'passed' }); save(); }
  async function checkAsync(name, run) { console.log(JSON.stringify({ event: 'staging_check', name, status: 'running' })); await run(); report.checks.push({ name, status: 'passed' }); save(); }
  const requestWithToken = `let token='';for await(const c of process.stdin)token+=c;
    const r=await fetch('http://127.0.0.1:8080/api/orders/routes',{headers:{authorization:'Bearer '+token},redirect:'error',signal:AbortSignal.timeout(5000)});
    if(r.status!==200||!Array.isArray((await r.json()).routes))process.exit(1);`;
  save();
  try {
    check('compose-config-without-secret-output', () => command(['config', '--quiet']));
    check('build-locked-api-image', () => command(['build', 'api'], { timeout: 900000 }));
    check('postgres-ready', () => command(['up', '-d', '--wait', '--wait-timeout', '120', 'db']));
    check('migrate-and-repeat-safely', () => { command(['run', '--rm', 'migrate']); command(['run', '--rm', 'migrate']); });
    check('production-api-healthy', () => command(['up', '-d', '--wait', '--wait-timeout', '120', 'api']));
    check('reject-weak-secret-before-boot', () => command(['run', '--rm', '--no-deps', '-e', 'SESSION_SECRET=weak', 'api'], { expected: 78 }));
    check('reject-memory-storage-before-boot', () => command(['run', '--rm', '--no-deps', '-e', 'TEZJET_STORAGE_ADAPTER=memory', 'api'], { expected: 78 }));
    const id = '11111111-1111-4111-8111-111111111111';
    check('seed-isolated-persistence-fixture', () => command(['exec', '-T', 'db', 'psql', '-U', 'onay', '-d', 'onay', '-v', 'ON_ERROR_STOP=1', '-tAc',
      `INSERT INTO tezjet_users (id, role, roles, full_name, phone_number, locale, profile_locked, session_version, created_at) VALUES ('${id}', 'passenger', '["passenger"]'::jsonb, 'Staging smoke', '+15555550101', 'ru', true, 0, '2026-10-24T00:00:00.000Z')`]));
    const token = command(['exec', '-T', 'api', 'node', '--input-type=module', '-e',
      `import {createRequire} from 'node:module';const jwt=createRequire('/app/artifacts/api-server/package.json')('jsonwebtoken');process.stdout.write(jwt.sign({sub:'${id}',role:'passenger',locale:'ru',sessionVersion:0,sessionId:'staging-smoke'},process.env.SESSION_SECRET,{expiresIn:'10m'}));`]);
    check('authenticated-api-reads-postgres', () => command(['exec', '-T', 'api', 'node', '--input-type=module', '-e', requestWithToken], { input: token }));
    check('production-does-not-expose-demo-otp', () => command(['exec', '-T', 'api', 'node', '--input-type=module', '-e',
      `const r=await fetch('http://127.0.0.1:8080/api/auth/request-otp',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({phone_number:'+15555550102',full_name:'Staging smoke',role:'passenger',locale:'ru'}),signal:AbortSignal.timeout(5000)});const b=await r.json();if(r.status!==202||Object.hasOwn(b,'demo_code')||Object.hasOwn(b,'code')){console.error('STAGING_OTP_STATUS_'+r.status);process.exit(1);}`]));
    check('same-session-survives-api-restart', () => { command(['restart', 'api']); command(['up', '-d', '--wait', '--wait-timeout', '120', 'api']); command(['exec', '-T', 'api', 'node', '--input-type=module', '-e', requestWithToken], { input: token }); });
    check('same-session-survives-postgres-restart', () => { command(['restart', 'db']); command(['up', '-d', '--wait', '--wait-timeout', '120', 'db', 'api']); command(['exec', '-T', 'api', 'node', '--input-type=module', '-e', requestWithToken], { input: token }); });
    const backup = join(temporary, 'onay.dump');
    await checkAsync('create-private-postgres-custom-backup', async () => {
      const result = await createBackup(args, backup);
      if (result.bytes < 5 || !/^[0-9a-f]{64}$/.test(result.sha256)) throw new Error('BACKUP_METADATA_INVALID');
      if ((statSync(backup).mode & 0o777) !== 0o600) throw new Error('BACKUP_PERMISSIONS_INVALID');
      let refused = false;
      try { await createBackup(args, backup); } catch (error) { refused = error.code === 'EEXIST'; }
      if (!refused || statSync(backup).size !== result.bytes) throw new Error('BACKUP_OVERWRITE_NOT_REFUSED');
    });
    // Add a row after the snapshot to distinguish an actual restore from reading the live DB.
    const laterId = '22222222-2222-4222-8222-222222222222';
    command(['exec', '-T', 'db', 'psql', '-U', 'onay', '-d', 'onay', '-v', 'ON_ERROR_STOP=1', '-tAc',
      `INSERT INTO tezjet_users (id, role, roles, full_name, phone_number, locale, profile_locked, session_version, created_at) VALUES ('${laterId}', 'passenger', '["passenger"]'::jsonb, 'After snapshot', '+15555550103', 'ru', true, 0, '2026-10-24T00:00:00.000Z')`]);
    await checkAsync('restore-snapshot-into-separate-database', async () => {
      const result = await verifyBackup(args, backup, { onRestored: async database => {
        command(['exec', '-T', 'db', 'psql', '-U', 'onay', '-d', database, '-v', 'ON_ERROR_STOP=1', '-tAc',
          `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM tezjet_users WHERE id='${id}' AND session_version=0 AND full_name='Staging smoke') OR EXISTS (SELECT 1 FROM tezjet_users WHERE id='${laterId}') THEN RAISE EXCEPTION 'SNAPSHOT_DATA_MISMATCH'; END IF; END $$;`]);
      } });
      if (!result.restored || !result.isolatedDatabase) throw new Error('RESTORE_RESULT_INVALID');
    });
    await checkAsync('corrupt-archive-fails-and-cleans-scratch-database', async () => {
      const corrupt = join(temporary, 'corrupt.dump'); writeFileSync(corrupt, 'PGDMPcorrupted-archive', { mode: 0o600 });
      let failed = false;
      try { await verifyBackup(args, corrupt); } catch { failed = true; }
      if (!failed) throw new Error('CORRUPT_BACKUP_ACCEPTED');
      command(['exec', '-T', 'db', 'psql', '-U', 'onay', '-d', 'onay', '-v', 'ON_ERROR_STOP=1', '-tAc',
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_database WHERE datname LIKE 'onay_restore_%') THEN RAISE EXCEPTION 'RESTORE_DATABASE_LEAKED'; END IF; END $$;`]);
    });
    check('live-database-and-session-unchanged-after-restore-drill', () => {
      command(['exec', '-T', 'db', 'psql', '-U', 'onay', '-d', 'onay', '-v', 'ON_ERROR_STOP=1', '-tAc',
        `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM tezjet_users WHERE id='${laterId}') THEN RAISE EXCEPTION 'LIVE_DATABASE_CHANGED'; END IF; END $$;`]);
      command(['exec', '-T', 'api', 'node', '--input-type=module', '-e', requestWithToken], { input: token });
    });
    const scheduled = { envFile, project, directory: join(temporary, 'scheduled'), keep: 2 };
    await checkAsync('automatic-backup-runs-verify-and-prune-only-completed-copies', async () => {
      for (let run = 0; run < 3; run++) await runScheduledBackup(scheduled);
      if (readdirSync(scheduled.directory).filter(name => name.endsWith('.dump')).length !== 2) throw new Error('BACKUP_RETENTION_FAILED');
      if ((await backupStatus(scheduled.directory)).state !== 'success') throw new Error('BACKUP_STATUS_FAILED');
    });
    await checkAsync('failed-automatic-backup-preserves-copies-and-reports-failure', async () => {
      const before = readdirSync(scheduled.directory).filter(name => name.endsWith('.dump')).sort();
      const prior = JSON.parse(readFileSync(join(scheduled.directory, 'status.json'), 'utf8'));
      command(['stop', 'db']);
      let rejected = false;
      try { await runScheduledBackup(scheduled); } catch { rejected = true; }
      const status = JSON.parse(readFileSync(join(scheduled.directory, 'status.json'), 'utf8'));
      if (!rejected || status.state !== 'failed' || status.lastSuccess !== prior.lastSuccess ||
        JSON.stringify(before) !== JSON.stringify(readdirSync(scheduled.directory).filter(name => name.endsWith('.dump')).sort())) throw new Error('BACKUP_FAILURE_DAMAGED_HISTORY');
      let unhealthy = false;
      try { await backupStatus(scheduled.directory); } catch { unhealthy = true; }
      if (!unhealthy) throw new Error('BACKUP_FAILURE_WAS_NOT_REPORTED');
      command(['up', '-d', '--wait', '--wait-timeout', '120', 'db', 'api']);
    });
    await checkAsync('automatic-backup-recovers-after-database-return-and-keeps-api-session', async () => {
      if ((await runScheduledBackup(scheduled)).state !== 'success') throw new Error('BACKUP_RECOVERY_FAILED');
      if ((await backupStatus(scheduled.directory)).state !== 'success') throw new Error('BACKUP_RECOVERY_STATUS_FAILED');
      command(['exec', '-T', 'api', 'node', '--input-type=module', '-e', requestWithToken], { input: token });
    });
    check('https-proxy-configuration-valid', () => command(['run', '--rm', '--no-deps', 'edge', 'caddy', 'validate', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile']));
    report.status = 'passed';
  } catch (error) { report.status = 'failed'; report.reasonCode = 'STAGING_RUNTIME_CHECK_FAILED'; throw new Error('ONAY_STAGING_RUNTIME_CHECK_FAILED'); }
  finally {
    try { command(['down', '--volumes', '--remove-orphans'], { timeout: 120000 }); }
    catch { report.status = 'failed'; report.cleanupFailed = true; }
    save(); rmSync(temporary, { recursive: true, force: true });
  }
  if (report.status !== 'passed') throw new Error('ONAY_STAGING_RUNTIME_CLEANUP_FAILED');
  console.log(JSON.stringify({ status: report.status, checksPassed: report.checks.length, realServerDeployed: false, publicHttpsVerified: false, smsDeliveryVerified: false }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await runStagingSmoke(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
