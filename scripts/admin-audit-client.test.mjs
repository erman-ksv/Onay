import test from 'node:test';
import assert from 'node:assert/strict';
import { AdminApiError, loadAdminAuditEvents } from '../artifacts/mockup-sandbox/src/admin/api.ts';

const filters = { orderId: '', driverId: '', routeId: '', limit: 50 };
const common = { id: 'event-id', actorId: 'administrator-id', createdAt: '2026-10-25T12:00:00.000Z' };
const route = { ...common, action: 'route.updated', routeId: 'route-id', changedFields: ['pricePerStop'], previousVersion: 'old', nextVersion: 'new' };
async function withFetch(fn, run) {
  const original = globalThis.fetch; globalThis.fetch = fn;
  try { await run(); } finally { globalThis.fetch = original; }
}
const response = payload => new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });

test('audit query omits blank IDs, encodes exact nonblank filters and keeps credentials out of URL/storage', async () => {
  await withFetch(async (url, options) => {
    const path = new URL(url, 'https://local.test');
    assert.equal(path.pathname, '/api/admin/audit-events');
    assert.deepEqual(Object.fromEntries(path.searchParams), { limit: '25', order_id: 'order /?&', route_id: 'route-id' });
    assert.equal(options.headers.Authorization, 'Bearer private-token');
    assert.equal(options.credentials, 'omit'); assert.equal(options.cache, 'no-store');
    assert.equal(path.href.includes('private-token'), false);
    return response({ events: [] });
  }, async () => assert.deepEqual(await loadAdminAuditEvents('private-token', { ...filters, orderId: ' order /?& ', driverId: '  ', routeId: 'route-id', limit: 25 }), []));
});

test('current three server event variants render from an explicit projection without sensitive unknown fields', async () => {
  const events = [route, { ...common, id: 'order-event', action: 'order.cancelled', orderId: 'order-id', fromStatus: 'in_transit', toStatus: 'cancelled' },
    { ...common, id: 'historical-driver-event', action: 'driver.approval_changed', driverId: 'driver-id', fromStatus: 'pending', toStatus: 'approved' }];
  await withFetch(async () => response({ events: events.map(event => ({ ...event, phone: 'private', payload: { token: 'private' } })) }), async () => {
    const result = await loadAdminAuditEvents('session', filters);
    assert.equal(result.length, 3); assert.equal(result[2].vehicleRevision, undefined);
    assert.deepEqual(result[0].changedFields, ['pricePerStop']);
    assert.equal(result.some(event => 'phone' in event || 'payload' in event), false);
  });
});

test('malformed, excessive and incomplete audit responses fail rather than showing an empty successful journal', async () => {
  for (const payload of [null, {}, { events: null }, { events: [null] }, { events: [{ ...route, createdAt: 'invalid' }] },
    { events: [{ ...route, changedFields: ['name', 5] }] }, { events: [{ ...route, routeId: undefined }] },
    { events: [{ ...common, action: 'order.cancelled', orderId: 'order', fromStatus: 'searching', toStatus: 'completed' }] },
    { events: Array.from({ length: 51 }, () => route) }]) {
    await withFetch(async () => response(payload), async () => assert.rejects(loadAdminAuditEvents('session', filters), error => error instanceof AdminApiError && error.status === 502));
  }
});

test('invalid bounds and overlong IDs are rejected before making a request', async () => {
  await withFetch(async () => { throw new Error('Invalid filters must not reach transport'); }, async () => {
    for (const patch of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { routeId: 'x'.repeat(101) }]) {
      await assert.rejects(loadAdminAuditEvents('session', { ...filters, ...patch }), error => error instanceof AdminApiError && error.status === 400);
    }
  });
});

test('aborted reads and expired permissions preserve failures for the component session guard', async () => {
  const controller = new AbortController(); controller.abort();
  await withFetch(async (_url, options) => { assert.equal(options.signal, controller.signal); throw new DOMException('Aborted', 'AbortError'); },
    async () => assert.rejects(loadAdminAuditEvents('session', filters, controller.signal), error => error.name === 'AbortError'));
  for (const status of [401, 403]) {
    await withFetch(async () => new Response(JSON.stringify({ error: { message: 'Access expired', code: 'UNAUTHORIZED' } }), { status }),
      async () => assert.rejects(loadAdminAuditEvents('session', filters), error => error instanceof AdminApiError && error.status === status));
  }
});

test('settings audit retains bounded before/after seconds and receipt while rejecting incomplete events', async () => {
  const event = { ...common, action: 'settings.offer_timeout_changed', settingKey: 'offer-timeout', previousValue: 60, nextValue: 90, nextVersion: 'new-receipt' };
  await withFetch(async () => response({ events: [{ ...event, secret: 'discard' }] }), async () => { const result = await loadAdminAuditEvents('session', filters); assert.deepEqual(JSON.parse(JSON.stringify(result)), [event]); assert.equal('secret' in result[0], false); });
  for (const patch of [{ settingKey: 'other' }, { previousValue: null }, { nextValue: 3601 }, { nextValue: 1.5 }, { nextVersion: undefined }]) {
    await withFetch(async () => response({ events: [{ ...event, ...patch }] }), async () => assert.rejects(loadAdminAuditEvents('session', filters), error => error.status === 502));
  }
});
