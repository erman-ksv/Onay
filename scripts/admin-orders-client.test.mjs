import test from 'node:test';
import assert from 'node:assert/strict';
import { AdminApiError } from '../artifacts/mockup-sandbox/src/admin/api.ts';
import { loadAdminOrders, cancelAdminOrder, isClosedAdminOrder, adminOrderStatuses } from '../artifacts/mockup-sandbox/src/admin/orders-api.ts';

const order = { id: 'real-order /?&', passenger_id: 'passenger', status: 'searching', seats: 2,
  created_at: '2026-10-25T12:00:00.000Z', updated_at: '2026-10-25T12:00:00.000Z',
  fare: { currency: 'UZS', total: 7000, pickupStop: { name: 'A' }, destinationStop: { name: 'B' } } };
const response = payload => new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
async function withFetch(fn, run) { const previous = globalThis.fetch; globalThis.fetch = fn; try { await run(); } finally { globalThis.fetch = previous; } }
async function parsed() { let result; await withFetch(async () => response({ orders: [order] }), async () => { [result] = await loadAdminOrders('private-token', 'active'); }); return result; }

test('orders read uses only supported status and preserves private header-only authentication', async () => {
  await withFetch(async (url, options) => {
    assert.equal(url, '/api/admin/orders?status=active'); assert.equal(options.headers.Authorization, 'Bearer private-token');
    assert.equal(options.cache, 'no-store'); assert.equal(options.credentials, 'omit');
    return response({ orders: [] });
  }, async () => assert.deepEqual(await loadAdminOrders('private-token', 'active'), []));
});
test('all actual order states are accepted; projection retains authoritative fare without phone GPS or payload', async () => {
  for (const status of adminOrderStatuses) await withFetch(async () => response({ orders: [{ ...order, status, passenger_phone: '+998900000000', pickup_location: { lat: 1 }, payload: 'private' }] }), async () => {
    const [result] = await loadAdminOrders('session', 'all');
    assert.equal(result.status, status); assert.equal(result.total, 7000); assert.equal(result.currency, 'UZS');
    assert.equal('passenger_phone' in result || 'pickup_location' in result || 'payload' in result, false);
    assert.equal(isClosedAdminOrder(result), status === 'completed' || status === 'cancelled');
  });
  await withFetch(async () => response({ orders: [{ ...order, fare: { currency: 'KZT', totalKzt: 500 } }] }), async () => {
    const [result] = await loadAdminOrders('session', 'all'); assert.equal(result.total, 500); assert.equal(result.currency, 'KZT');
  });
});
test('invalid or duplicated orders and inconsistent currency fields fail instead of enabling unsafe cancellation', async () => {
  for (const payload of [null, {}, { orders: [null] }, { orders: [order, order] }, { orders: [{ ...order, seats: 9 }] },
    { orders: [{ ...order, status: 'invented' }] }, { orders: [{ ...order, created_at: 'invalid' }] },
    { orders: [{ ...order, fare: { currency: 'UZS', total: 7000, totalKzt: 7000 } }] },
    { orders: [{ ...order, fare: { currency: 'KZT', total: 600, totalKzt: 500 } }] }]) {
    await withFetch(async () => response(payload), async () => assert.rejects(loadAdminOrders('session', 'all'), error => error instanceof AdminApiError && error.status === 502));
  }
});
test('cancellation posts exactly the captured status and encoded ID once, checking exact confirmed result', async () => {
  const observed = await parsed(); let calls = 0;
  await withFetch(async (url, options) => {
    calls++; assert.equal(url, '/api/admin/orders/' + encodeURIComponent(order.id) + '/cancel');
    assert.equal(options.method, 'POST'); assert.deepEqual(JSON.parse(options.body), { expected_status: 'searching' });
    assert.equal(options.headers.Authorization, 'Bearer private-token');
    return response({ order: { ...order, status: 'cancelled' } });
  }, async () => assert.equal((await cancelAdminOrder('private-token', observed)).status, 'cancelled'));
  assert.equal(calls, 1);
  for (const returned of [{ ...order, id: 'wrong', status: 'cancelled' }, order]) await withFetch(async () => response({ order: returned }), async () => assert.rejects(cancelAdminOrder('session', observed), error => error instanceof AdminApiError && error.status === 502));
});
test('closed orders are refused before transport; conflicts and unknown outcomes never auto-retry', async () => {
  const observed = await parsed();
  await withFetch(async () => { throw new Error('Closed order must not be posted'); }, async () => {
    for (const status of ['completed', 'cancelled']) await assert.rejects(cancelAdminOrder('session', { ...observed, status }), error => error instanceof AdminApiError && error.status === 400);
  });
  for (const status of [401, 403, 404, 409, 503]) {
    let calls = 0;
    await withFetch(async () => { calls++; return new Response(JSON.stringify({ error: { code: 'ORDER_UNAVAILABLE', message: 'Rejected' } }), { status }); },
      async () => assert.rejects(cancelAdminOrder('session', observed), error => error instanceof AdminApiError && error.status === status));
    assert.equal(calls, 1);
  }
  let calls = 0;
  await withFetch(async () => { calls++; throw new TypeError('Network unavailable'); }, async () => assert.rejects(cancelAdminOrder('session', observed), TypeError));
  assert.equal(calls, 1);
});
test('current abort signal is forwarded on both reads and mutation without swallowing cancellation', async () => {
  const observed = await parsed(); const controller = new AbortController(); controller.abort();
  await withFetch(async (_url, options) => { assert.equal(options.signal, controller.signal); throw new DOMException('Aborted', 'AbortError'); }, async () => {
    await assert.rejects(loadAdminOrders('session', 'active', controller.signal), error => error.name === 'AbortError');
    await assert.rejects(cancelAdminOrder('session', observed, controller.signal), error => error.name === 'AbortError');
  });
});
