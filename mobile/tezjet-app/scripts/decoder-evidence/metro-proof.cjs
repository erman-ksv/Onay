'use strict';

// Run from the actual isolated mobile project. No aliases, package copies,
// namespace injections or resolver changes are used to obtain interoperability.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');

const app = process.cwd();
const req = createRequire(path.join(app, 'package.json'));
const expoReq = createRequire(req.resolve('expo/package.json'));
const metroReq = createRequire(expoReq.resolve('@expo/metro-config/package.json'));
const Metro = metroReq('metro');
const cliRoot = path.dirname(expoReq.resolve('@expo/cli/package.json'));
const { loadMetroConfigAsync } = req(path.join(cliRoot, 'build/src/start/server/metro/instantiateMetro.js'));
const { getConfig } = expoReq('@expo/config');
const routerReq = createRequire(req.resolve('expo-router/package.json'));
const queryFile = routerReq.resolve('query-string');
const ts = req('typescript');
const output = path.resolve(process.argv[2] || 'dist/decoder-proof');
fs.mkdirSync(output, { recursive: true });

function actualFunction(relative, name) {
  const filename = routerReq.resolve(relative);
  const text = fs.readFileSync(filename, 'utf8');
  const ast = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const node = ast.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === name);
  if (!node) throw new Error('Actual Router function missing: ' + name);
  return { filename, name, sha256: digest(node.getText(ast)), source: node.getText(ast) };
}
function digest(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
const functions = [
  actualFunction('./build/fork/getStateFromPath-forks.js', 'parseQueryParams'),
  actualFunction('./build/fork/getPathFromState-forks.js', 'appendQueryAndHash'),
];
// Source function extraction avoids loading unrelated native UI during this JS
// probe. The actual installed query-string/decoder graph is loaded by Metro.
const entry = path.join(app, 'scripts/decoder-evidence/.metro-entry.js');
const source = `const queryString = require(${JSON.stringify(queryFile)});
const checkParent = require('./parent-checks.cjs');
${functions.map(item => item.source).join('\n')}
const checks = checkParent(queryString);
const incoming = parseQueryParams('/home?x=a+b&x=a%2Bb&n=2&keep=attempt', {params:{keep:'path'}}, {n:Number}, '#hello+world');
if (JSON.stringify(incoming) !== JSON.stringify({'#':'hello+world', x:['a b','a+b'], n:2})) throw new Error('Router parse/config changed: '+JSON.stringify(incoming));
const outgoing = appendQueryAndHash('/home', {x:['a+b','Имя'], '#':'hello'});
if (outgoing !== '/home?x=a%2Bb&x=%D0%98%D0%BC%D1%8F#hello') throw new Error('Router stringify changed: '+outgoing);
globalThis.ONAY_DECODER_METRO_PROOF = { ...checks, incoming, outgoing };
`;
fs.writeFileSync(entry, source);

(async () => {
  const receipt = {
    sourceSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    entrySha256: digest(source), patchSha256: digest(fs.readFileSync('patches/query-string@7.1.3.patch')),
    lockSha256: digest(fs.readFileSync('pnpm-lock.yaml')),
    queryFile: path.relative(app, queryFile),
    actualRouterFunctions: functions.map(({ source, ...item }) => item),
    nativeHermesRuntime: 'UNVERIFIED', platforms: [],
  };
  for (const platform of ['android', 'ios', 'web']) {
    const exp = getConfig(app, { skipSDKVersionRequirement: true }).exp;
    let server;
    const { config } = await loadMetroConfigAsync(app, { maxWorkers: 1 }, {
      exp, isExporting: true, getMetroBundler: () => server.getBundler().getBundler(),
    });
    config.reporter = { update() {} };
    const out = path.join(output, platform + '.js');
    server = await Metro.runMetro(config, { watch: false });
    try {
      const bundle = await server.build({ entryFile: entry, platform, dev: false, minify: false,
        runModule: true, modulesOnly: false,
        inlineSourceMap: false, createModuleIdFactory: config.serializer.createModuleIdFactory });
      fs.writeFileSync(out, bundle.code);
    } finally { await server.end(); }
    const emitted = fs.readFileSync(out, 'utf8');
    // Standard JS host globals only. The ESM namespace and Metro module loading
    // are produced by the real serializer, never provided by this harness.
    const context = { console, URL, URLSearchParams, setTimeout, clearTimeout, performance,
      process: { env: { NODE_ENV: 'production' } } };
    vm.runInNewContext(emitted, context, { timeout: 10000, filename: out });
    const result = context.ONAY_DECODER_METRO_PROOF;
    if (!result || result.corpusCases !== 300) throw new Error('Metro proof did not execute: ' + platform);
    const item = { platform, bundleSha256: digest(emitted), bytes: Buffer.byteLength(emitted), execution: 'PASS', result };
    if (platform !== 'web') {
      const compiler = path.join(path.dirname(req.resolve('react-native/package.json')), 'sdks/hermesc/linux64-bin/hermesc');
      execFileSync(compiler, ['-emit-binary', '-out', out + '.hbc', out], { stdio: 'pipe' });
      item.hermesCompile = 'PASS';
      item.bytecodeSha256 = digest(fs.readFileSync(out + '.hbc'));
    }
    receipt.platforms.push(item);
    fs.writeFileSync(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
    console.log(JSON.stringify(item));
  }
})().catch(error => { console.error(error); process.exitCode = 1; })
  .finally(() => { fs.rmSync(entry, { force: true }); });
