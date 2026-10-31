import test from 'node:test';
import assert from 'node:assert/strict';
import { loadOfferTimeout, saveOfferTimeout, readOfferTimeoutDraft } from '../artifacts/mockup-sandbox/src/admin/offer-timeout-api.ts';
import { AdminApiError } from '../artifacts/mockup-sandbox/src/admin/api.ts';
const initial = { seconds: 60, revision: null, updatedAt: null };
const saved = { seconds: 90, revision: 'server-receipt', updatedAt: '2026-10-31T12:00:00.000Z' };
const response = value => new Response(JSON.stringify({ offer_timeout: value }), { status: 200 });
async function withFetch(fn, run) { const original = globalThis.fetch; globalThis.fetch = fn; try { await run(); } finally { globalThis.fetch = original; } }
test('timeout drafts accept only bounded whole seconds before transport', async () => {
  for (const [input, expected] of [['1', 1], [' 90 ', 90], ['3600', 3600]]) assert.equal(readOfferTimeoutDraft(input), expected);
  for (const input of ['', '0', '-1', '3601', '1.5', '1e2', 'Infinity', 'NaN', '9'.repeat(100)]) assert.throws(() => readOfferTimeoutDraft(input));
  await withFetch(() => { throw new Error('Invalid value reached transport'); }, async () => {
    for (const value of [0, 3601, 1.5, NaN, '90']) await assert.rejects(saveOfferTimeout('token', value, null), error => error.status === 400);
  });
});
test('authenticated private GET forwards cancellation and confirms default or saved policy', async () => {
  const controller = new AbortController();
  for (const policy of [initial, saved]) await withFetch(async (url, options) => {
    assert.equal(url, '/api/admin/settings/offer-timeout'); assert.equal(options.method, 'GET');
    assert.equal(options.cache, 'no-store'); assert.equal(options.credentials, 'omit');
    assert.equal(options.headers.Authorization, 'Bearer test-token'); assert.equal(options.signal, controller.signal);
    return response({ ...policy, password: 'discard' });
  }, async () => assert.deepEqual(await loadOfferTimeout('test-token', controller.signal), policy));
});
test('save sends an explicit revision and accepts only a confirmed matching durable value', async () => {
  const controller = new AbortController();
  await withFetch(async (url, options) => {
    assert.equal(url, '/api/admin/settings/offer-timeout'); assert.equal(options.method, 'PUT');
    assert.deepEqual(JSON.parse(options.body), { seconds: 90, expected_revision: null });
    assert.equal(options.cache, 'no-store'); assert.equal(options.signal, controller.signal);
    return response(saved);
  }, async () => assert.deepEqual(await saveOfferTimeout('token', 90, null, controller.signal), saved));
  for (const policy of [initial, { ...saved, seconds: 80 }]) await withFetch(async () => response(policy),
    async () => assert.rejects(saveOfferTimeout('token', 90, 'old'), error => error.status === 502));
});
test('malformed and inconsistent policies cannot masquerade as a successful read', async () => {
  for (const policy of [null, {}, [], { ...initial, seconds: 0 }, { ...initial, seconds: 3601 },
    { ...initial, seconds: '60' }, { ...initial, revision: '' }, { ...initial, updatedAt: saved.updatedAt },
    { ...saved, updatedAt: null }, { ...saved, updatedAt: 'invalid' }, { ...saved, seconds: 1.5 }]) {
    await withFetch(async () => response(policy), async () => assert.rejects(loadOfferTimeout('token'), error => error instanceof AdminApiError && error.status === 502));
  }
});
test('conflict, expired access, abort and unknown save outcome propagate once without retry', async () => {
  for (const status of [401, 403, 409]) { let calls = 0;
    await withFetch(async () => { calls++; return new Response(JSON.stringify({ error: { message: 'changed', code: 'OFFER_TIMEOUT_CHANGED' } }), { status }); },
      async () => assert.rejects(saveOfferTimeout('token', 90, 'old'), error => error.status === status && error.code === 'OFFER_TIMEOUT_CHANGED'));
    assert.equal(calls, 1);
  }
  for (const failure of [new TypeError('Response lost'), new DOMException('Aborted', 'AbortError')]) { let calls = 0;
    await withFetch(async () => { calls++; throw failure; }, async () => assert.rejects(saveOfferTimeout('token', 90, 'old'), failure)); assert.equal(calls, 1);
  }
});
