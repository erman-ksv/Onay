import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTripStatistics, parseTripStatistics } from '../artifacts/mockup-sandbox/src/admin/statistics-api.ts';
import { AdminApiError } from '../artifacts/mockup-sandbox/src/admin/api.ts';

const empty = () => ({ statistics: { total: 0, active: 0, completed: 0, cancelled: 0,
  by_status: { searching: 0, en_route_to_c: 0, arrived_at_c: 0, boarded_waiting: 0, in_transit: 0, completed: 0, cancelled: 0 } },
  fare_summary: { basis: 'completed_order_fares', missing_fare_orders: 0, overflow: false, totals: [] } });
const completed = () => { const value = empty(); value.statistics.total = value.statistics.completed = value.statistics.by_status.completed = 2;
  value.fare_summary.totals = [{ currency: 'KZT', total: 500, orders: 1 }, { currency: 'UZS', total: 0, orders: 1 }]; return value; };

test('genuine empty and completed multi-currency statistics retain exact sums and counts', () => {
  assert.deepEqual(parseTripStatistics(empty()), empty()); assert.deepEqual(parseTripStatistics(completed()), completed());
});
test('missing fares and overflow require null totals, never a plausible partial sum', () => {
  for (const reason of ['missing', 'overflow']) {
    const value = completed(); value.fare_summary.totals = null;
    if (reason === 'missing') value.fare_summary.missing_fare_orders = 1; else value.fare_summary.overflow = true;
    assert.deepEqual(parseTripStatistics(value), value);
    value.fare_summary.totals = []; assert.throws(() => parseTripStatistics(value), AdminApiError);
  }
});
test('inconsistent counters, duplicate currencies, unknown money and unsafe totals fail closed', () => {
  const invalid = [];
  for (const edit of [v => v.statistics.total++, v => v.statistics.active++, v => v.statistics.by_status.completed++,
    v => v.fare_summary.totals.push(v.fare_summary.totals[0]), v => v.fare_summary.totals[0].orders++,
    v => v.fare_summary.totals[0].total = -1, v => v.fare_summary.totals[0].total = Number.MAX_SAFE_INTEGER + 1,
    v => v.fare_summary.totals[0].currency = 'USD', v => v.fare_summary.basis = 'payments',
    v => v.fare_summary.missing_fare_orders = 3]) { const value = completed(); edit(value); invalid.push(value); }
  for (const value of [null, {}, ...invalid]) assert.throws(() => parseTripStatistics(value), AdminApiError);
});
test('unexpected raw identities and order details are discarded by the aggregate parser', () => {
  const value = completed(); value.passenger_phone = 'private'; value.statistics.orders = ['private']; value.fare_summary.totals[0].driver_id = 'private';
  assert.deepEqual(parseTripStatistics(value), completed());
});
test('statistics loader uses one authenticated no-store GET, forwards abort and propagates authorization errors', async t => {
  const previous = globalThis.fetch, calls = [], controller = new AbortController();
  t.after(() => { globalThis.fetch = previous; });
  globalThis.fetch = async (url, options) => { calls.push({ url, options }); return new Response(JSON.stringify(empty()), { status: 200 }); };
  assert.deepEqual(await loadTripStatistics('test-token', controller.signal), empty());
  assert.equal(calls.length, 1); assert.equal(calls[0].url, '/api/admin/statistics/trips');
  assert.equal(calls[0].options.method, 'GET'); assert.equal(calls[0].options.cache, 'no-store'); assert.equal(calls[0].options.credentials, 'omit');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer test-token'); assert.equal(calls[0].options.signal, controller.signal);
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'Forbidden' } }), { status: 403 });
  await assert.rejects(loadTripStatistics('test-token'), error => error instanceof AdminApiError && error.status === 403);
});
