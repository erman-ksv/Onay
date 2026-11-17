'use strict';
const { Worker } = require('node:worker_threads');
const { createRequire } = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
const req = createRequire(path.join(process.cwd(), 'package.json'));
const routerReq = createRequire(req.resolve('expo-router/package.json'));
const candidate = routerReq.resolve('query-string');
const baseline = process.argv[2];
if (!baseline || !fs.existsSync(baseline)) throw new Error('Supply exact existing baseline query-string index.js path');

async function bounded(entry, input) {
  return new Promise(resolve => {
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      const q = require(workerData.entry);
      const started = performance.now();
      const parsed = q.parse('x=' + workerData.input);
      parentPort.postMessage({completed:true, elapsedMs: performance.now()-started, outputLength:parsed.x.length});
    `, { eval: true, workerData: { entry, input }, resourceLimits: { maxOldGenerationSizeMb: 32 } });
    let settled = false;
    const finish = async result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      await worker.terminate();
      resolve(result);
    };
    const timer = setTimeout(() => { void finish({ timeout: true, boundMs: 500 }); }, 500);
    worker.once('message', result => { void finish(result); });
    worker.once('error', error => { void finish({ error: error.message }); });
    worker.once('exit', code => { if (!settled) void finish({ exited: code }); });
  });
}
(async () => {
  const results = [];
  for (const [name, sequence] of [['invalid-run', '%C0'], ['mixed-run', '%FF%41']]) {
    for (const size of [128, 512, 2048]) {
      for (const [version, entry] of [['baseline0.2.2', baseline], ['candidate0.5.1', candidate]]) {
        const result = { name, size, version, inputLength: sequence.length * size,
          ...await bounded(entry, sequence.repeat(size)) };
        results.push(result);
        console.log(JSON.stringify(result));
      }
    }
  }
  const green = results.filter(item => item.version === 'candidate0.5.1').every(item => item.completed);
  const red = ['invalid-run', 'mixed-run'].every(name => results.some(item =>
    item.name === name && item.version === 'baseline0.2.2' && item.size === 2048 && !item.completed));
  const receipt = { green, red, workerOldGenerationMb: 32, wallTimeBoundMs: 500, results,
    limitation: 'Observed bounded parent-parser behavior, not a formal complexity proof or device timing SLA' };
  fs.mkdirSync('dist/decoder-proof', { recursive: true });
  fs.writeFileSync('dist/decoder-proof/bounded-parent.json', JSON.stringify(receipt, null, 2) + '\n');
  if (!green || !red) throw new Error('Expected bounded old RED/candidate GREEN was not established');
})().catch(error => { console.error(error); process.exitCode = 1; });
