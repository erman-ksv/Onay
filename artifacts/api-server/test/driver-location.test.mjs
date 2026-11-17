import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let directory, readDriverLocation;
before(async () => {
  directory = await mkdtemp(path.join(apiRoot, '.driver-location-test-'));
  const entry = path.join(directory, 'location.mjs');
  await build({ entryPoints: [path.join(apiRoot, 'src/utils/driverLocation.ts')], outfile: entry, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
  ({ readDriverLocation } = await import(pathToFileURL(entry).href));
});
after(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });
test('driver location rejects malformed, nonfinite, coerced and out-of-range coordinates', () => {
  for (const value of [null, [], 'point', {}, { lat: '41', lng: 69 }, { lat: 41, lng: null }, { lat: NaN, lng: 0 }, { lat: Infinity, lng: 0 }, { lat: 0, lng: -Infinity }, { lat: 90.01, lng: 0 }, { lat: -90.01, lng: 0 }, { lat: 0, lng: 180.01 }, { lat: 0, lng: -180.01 }]) {
    assert.equal(readDriverLocation(value), undefined);
  }
});
test('driver location validates timestamps and mock flags without coercion', () => {
  for (const timestamp of [0, -1, NaN, Infinity, '123', null, false]) assert.equal(readDriverLocation({ lat: 0, lng: 0, timestamp }), undefined);
  for (const isMocked of [null, 'false', 0, 1, {}]) assert.equal(readDriverLocation({ lat: 0, lng: 0, isMocked }), undefined);
});
test('driver location preserves valid boundaries and strips unrelated client fields', () => {
  for (const lat of [-90, 90]) for (const lng of [-180, 180]) {
    assert.deepEqual(readDriverLocation({ lat, lng, timestamp: 1, isMocked: false, private: 'do not relay', driver_id: 'spoof' }), { lat, lng, timestamp: 1, isMocked: false });
  }
  const before = Date.now();
  const location = readDriverLocation({ lat: 0, lng: 0 });
  assert.equal(location.lat, 0);
  assert.equal(location.lng, 0);
  assert.ok(location.timestamp >= before && location.timestamp <= Date.now());
});
