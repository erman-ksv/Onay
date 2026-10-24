import { writeSync } from "node:fs";
import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { verifyStagingEnvironment } from './verify-env.mjs';
try { verifyStagingEnvironment(process.env); }
catch (error) { writeSync(2, error.message + "\n"); process.exit(78); }
const [command, ...args] = process.argv.slice(2);
if (!command) { writeSync(2, "ONAY_STAGING_COMMAND_REQUIRED\n"); process.exit(78); }
const child = spawn(command, args, { stdio: 'inherit' });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.on('error', () => { writeSync(2, "ONAY_STAGING_COMMAND_UNAVAILABLE\n"); process.exit(1); });
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 128 + (constants.signals[signal] ?? 0) : 1)));
