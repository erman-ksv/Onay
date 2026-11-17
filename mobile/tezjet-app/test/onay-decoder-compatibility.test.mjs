import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import checkParent from '../scripts/decoder-evidence/parent-checks.cjs';

const require = createRequire(import.meta.url);
const routerRequire = createRequire(require.resolve('expo-router/package.json'));
const queryRequire = createRequire(routerRequire.resolve('query-string'));
const q = routerRequire('query-string');

test('actual installed Router parent retains supported query semantics with the fixed decoder', () => {
  assert.equal(queryRequire('query-string/package.json').version, '7.1.3');
  const decoderFile = queryRequire.resolve('decode-uri-component');
  const metadata = JSON.parse(readFileSync(new URL('./package.json', 'file://' + decoderFile), 'utf8'));
  assert.equal(metadata.version, '0.5.1');
  assert.equal(typeof queryRequire('decode-uri-component').default, 'function');
  const result = checkParent(q);
  assert.equal(result.corpusCases, 300);
  assert.equal(result.malformedRescan, '%C2%FF');
});

test('fixed upstream decoder retains invalid argument errors and plus wrapper does not disable decoding', () => {
  const decoder = queryRequire('decode-uri-component').default;
  for (const input of [null, undefined, 1, {}, []]) assert.throws(() => decoder(input), TypeError);
  assert.equal(q.parse('name=%D0%98%D0%BC%D1%8F&x=a%2Bb+c').name, 'Имя');
  assert.equal(q.parse('x=a%2Bb+c').x, 'a+b c');
});
