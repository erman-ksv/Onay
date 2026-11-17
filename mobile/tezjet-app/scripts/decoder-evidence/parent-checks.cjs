'use strict';

// Shared by Node tests and the real Metro probe: neither replaces the decoder.
const corpus = require('../../test/fixtures/onay-decoder-corpus.json');

module.exports = function checkParent(q) {
  let checks = 0;
  const equal = (actual, expected, label) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(label + ': ' + JSON.stringify({ actual, expected }));
    }
    checks++;
  };
  const throws = (action, label) => {
    let error;
    try { action(); } catch (caught) { error = caught; }
    if (!(error instanceof Error)) throw new Error(label + ': expected an error');
    checks++;
  };
  for (const item of corpus.cases) {
    const actual = q.parse(item.query, item.options);
    // Parse expectation at runtime: Metro's JSON-to-object-literal transformer
    // otherwise interprets a fixture's __proto__ key as object literal syntax.
    equal(actual, JSON.parse(item.expectedJson), 'parse ' + item.query + ' ' + JSON.stringify(item.options));
    equal(Object.getPrototypeOf(actual), null, 'parse result must have no prototype');
  }
  equal(q.parseUrl('https://example.invalid/p?x=a%2Bb+c#hello+world', { parseFragmentIdentifier: true }),
    { url: 'https://example.invalid/p', query: { x: 'a+b c' }, fragmentIdentifier: 'hello world' }, 'fragment plus');
  equal(q.parseUrl('https://example.invalid/p#hello%2Bworld', { parseFragmentIdentifier: true }).fragmentIdentifier,
    'hello+world', 'encoded fragment plus');
  equal(q.parseUrl('https://example.invalid/p#hello+world', { parseFragmentIdentifier: true, decode: false }).fragmentIdentifier,
    'hello+world', 'fragment decode false');
  equal(q.stringify({ z: 'a+b c', a: ['Имя', '😀'] }),
    'a=%D0%98%D0%BC%D1%8F&a=%F0%9F%98%80&z=a%2Bb%20c', 'stringify');
  equal(q.stringifyUrl({ url: 'https://example.invalid/p?x=a+b', query: { y: 'c+d' }, fragmentIdentifier: 'hello world' }),
    'https://example.invalid/p?x=a%20b&y=c%2Bd#hello%20world', 'stringifyUrl');
  equal(q.pick('https://example.invalid/p?z=2&x=a+b#hello+world', ['x']),
    'https://example.invalid/p?x=a%20b#hello world', 'pick');
  equal(q.exclude('https://example.invalid/p?z=2&x=a+b#hello+world', ['z']),
    'https://example.invalid/p?x=a%20b#hello world', 'exclude');
  equal(Object.keys(q.parse('a=1&z=2', { sort: (a, b) => b.localeCompare(a) })), ['z', 'a'], 'custom sort');
  equal(q.parse(null), {}, 'non-string parse');
  equal(q.stringify(null), '', 'null stringify');
  throws(() => q.parse('x=1', { arrayFormatSeparator: '||' }), 'invalid parse separator');
  throws(() => q.stringify({ x: ['1'] }, { arrayFormatSeparator: '' }), 'invalid stringify separator');
  throws(() => q.parseUrl(null), 'invalid parseUrl argument');
  throws(() => q.stringifyUrl(null), 'invalid stringifyUrl argument');
  equal(Object.prototype.hasOwnProperty.call(q.parse('__proto__=x'), '__proto__'), true, 'own proto key');
  equal({}.polluted, undefined, 'no Object.prototype pollution');
  return { checks, corpusCases: corpus.cases.length, malformedRescan: q.parse('x=%25C2%FF').x };
};
