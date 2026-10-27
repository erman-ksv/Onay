import test from 'node:test';
import assert from 'node:assert/strict';
import { loadAdminMonitoring } from '../artifacts/mockup-sandbox/src/admin/monitoring-api.ts';
import { AdminApiError } from '../artifacts/mockup-sandbox/src/admin/api.ts';

const updated = '2026-10-26T07:00:00.000Z';
const order = { id: 'order-one', passenger_id: 'passenger-one', driver_id: 'driver-a', status: 'in_transit', seats: 2,
  created_at: updated, updated_at: updated, pickup_point: 'A', destination: 'B', fare: { currency: 'UZS', total: 2400 } };
const configured = { kind: 'configured', route_id: 'route-one', route_name: 'Линия', direction: 'a_to_b', pitak: 'A',
  stop_code: 'A', stop_name: 'Питак A', route_updated_at: updated };
const row = { driver_id: 'driver-a', position: 1, joined_at: 1, status: 'searching', available_seats: 4, lane: configured };
const response = payload => Response.json(payload);
async function withFetch(fetcher, run) {
  const original = globalThis.fetch;
  globalThis.fetch = fetcher;
  try { await run(); } finally { globalThis.fetch = original; }
}
function transport(queuePayload = { total_queued: 1, queue: [row] }, orders = [order]) {
  return async url => response(url.startsWith('/api/admin/orders?') ? { orders } : queuePayload);
}
const bad = error => error instanceof AdminApiError && error.status === 502;

test('monitoring starts both GET reads in parallel with exact queries, private headers and shared cancellation', async () => {
  const controller = new AbortController(), calls = [], resolvers = [];
  let published = false;
  await withFetch((url, options) => {
    calls.push({ url, options });
    return new Promise(resolve => resolvers.push(resolve));
  }, async () => {
    const pending = loadAdminMonitoring('private-token', controller.signal).then(result => { published = true; return result; });
    assert.equal(calls.length, 2, 'A sequential waterfall must not wait for the first response.');
    assert.deepEqual(calls.map(call => call.url), ['/api/admin/orders?status=active', '/api/admin/queue?include_lanes=true']);
    for (const { url, options } of calls) {
      assert.equal(options.method, 'GET');
      assert.equal(options.headers.Authorization, 'Bearer private-token');
      assert.equal(options.signal, controller.signal);
      assert.equal(options.cache, 'no-store');
      assert.equal(options.credentials, 'omit');
      assert.equal(url.includes('private-token'), false);
      assert.equal(options.body, undefined);
    }
    resolvers[1](response({ total_queued: 0, queue: [] }));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(published, false, 'A successful half must never publish partial monitoring.');
    resolvers[0](response({ orders: [] }));
    assert.deepEqual(await pending, { orders: [], queue: [] });
  });
});

test('configured and legacy lanes keep safe fields while lane-local positions and frozen UZS orders survive', async () => {
  const rows = [
    { ...row, phone: 'PRIVATE', lastLocation: { lat: 42 }, pendingOfferOrderId: 'PRIVATE', lane: { ...configured, center: { lat: 42 }, radiusMeters: 200 } },
    { ...row, driver_id: 'driver-b', available_seats: 0, lane: { ...configured, direction: 'b_to_a', pitak: 'B', stop_code: 'B' } },
    { ...row, driver_id: 'driver-legacy', lane: { kind: 'legacy', phone: 'PRIVATE' } },
  ];
  await withFetch(transport({ total_queued: 3, queue: rows }, [{ ...order, passenger_phone: 'PRIVATE', pickup_location: { lat: 42 } }]), async () => {
    const result = await loadAdminMonitoring('session');
    assert.equal(result.queue.length, 3);
    assert.deepEqual(result.queue.map(row => row.position), [1, 1, 1]);
    assert.equal(result.queue[1].availableSeats, 0);
    assert.deepEqual(result.queue[0].lane, { kind: 'configured', routeId: 'route-one', routeName: 'Линия', direction: 'a_to_b', pitak: 'A',
      stopCode: 'A', stopName: 'Питак A', routeUpdatedAt: updated });
    assert.deepEqual(result.queue[2].lane, { kind: 'legacy' });
    assert.deepEqual(Object.keys(result.queue[0]).sort(), ['driverId', 'position', 'joinedAt', 'status', 'availableSeats', 'lane'].sort());
    assert.equal(result.orders[0].currency, 'UZS');
    assert.equal(result.orders[0].total, 2400);
    assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
    assert.equal(JSON.stringify(result).includes('lastLocation'), false);
    assert.equal(JSON.stringify(result).includes('radiusMeters'), false);
  });
});

test('malformed queue data, duplicate drivers, invalid bounds and inconsistent lane identities fail closed', async () => {
  const lanePatches = [null, [], { kind: 'future' }, { ...configured, direction: 'b_to_a' }, { ...configured, route_id: '' },
    { ...configured, route_name: '   ' }, { ...configured, stop_code: null }, { ...configured, stop_name: [] }, { ...configured, route_updated_at: 'invalid' }];
  const rowPatches = [{ driver_id: '' }, { position: 0 }, { position: 1.2 }, { joined_at: -1 }, { joined_at: NaN },
    { available_seats: -1 }, { available_seats: 9 }, { available_seats: 1.5 }, { status: 'completed' }, ...lanePatches.map(lane => ({ lane }))];
  const payloads = [null, [], {}, { total_queued: -1, queue: [] }, { total_queued: '0', queue: [] },
    { total_queued: 0, queue: [row] }, { total_queued: 1, queue: null }, { total_queued: 1, queue: [null] },
    { total_queued: 2, queue: [row, row] }, ...rowPatches.map(patch => ({ total_queued: 1, queue: [{ ...row, ...patch }] }))];
  for (const payload of payloads) {
    await withFetch(transport(payload), async () => assert.rejects(loadAdminMonitoring('session'), bad));
  }
});

test('active-order endpoint must not return completed, cancelled, duplicate or malformed orders', async () => {
  for (const orders of [[{ ...order, status: 'completed' }], [{ ...order, status: 'cancelled' }], [order, order], [null]]) {
    await withFetch(transport({ total_queued: 0, queue: [] }, orders), async () => assert.rejects(loadAdminMonitoring('session'), bad));
  }
});

test('failed half is an error rather than empty success; no automatic retries or mutations occur', async () => {
  for (const failingPath of ['/api/admin/orders?', '/api/admin/queue?']) {
    for (const status of [401, 403, 500]) {
      const calls = [];
      await withFetch(async (url, options) => {
        calls.push({ url, method: options.method });
        if (url.startsWith(failingPath)) return Response.json({ error: { message: 'Access failed' } }, { status });
        return transport({ total_queued: 0, queue: [] }, [])(url);
      }, async () => {
        await assert.rejects(loadAdminMonitoring('session'), error => error instanceof AdminApiError && error.status === status);
        assert.equal(calls.length, 2);
        assert.equal(calls.every(call => call.method === 'GET'), true);
      });
    }
  }
  await withFetch(async () => { throw new TypeError('Network unavailable'); }, async () => assert.rejects(loadAdminMonitoring('session'), TypeError));
});

test('aborting the round reaches both fetches and cannot be turned into an empty snapshot', async () => {
  const controller = new AbortController(), signals = [];
  await withFetch((_url, options) => {
    signals.push(options.signal);
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
  }, async () => {
    const pending = loadAdminMonitoring('session', controller.signal);
    assert.deepEqual(signals, [controller.signal, controller.signal]);
    controller.abort();
    await assert.rejects(pending, error => error.name === 'AbortError');
  });
});
