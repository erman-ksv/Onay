import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { before, after, test } from 'node:test';
import { build } from 'esbuild';

const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let directory, getSmsConfiguration, sendOtpSms, OtpSmsError;
before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'onay-sms-provider-'));
  const outfile = path.join(directory, 'provider.mjs');
  await build({ entryPoints: [path.join(apiRoot, 'src/services/otpSms.ts')], outfile, bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent' });
  ({ getSmsConfiguration, sendOtpSms, OtpSmsError } = await import(pathToFileURL(outfile).href));
});
after(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });
const key = 'private-test-key-not-a-real-provider-credential';
const code = '462813';
const phone = '+998901234567';
const deliveryId = '3f2b8a52-7c1d-4e0a-9b4f-6d5c1a2e8b70';
const input = () => ({ phoneNumber: phone, code, deliveryId });
const env = patch => ({ NODE_ENV: 'production', TEZJET_SMS_PROVIDER: 'devsms', TEZJET_SMS_SEND_ENABLED: 'true', DEVSMS_API_KEY: key, ...patch });
const config = patch => getSmsConfiguration(env(patch));
const good = (patch = {}) => ({ success: true, data: { id: 123, phone: phone.slice(1), status: 'sent', outcome: 'sent', ...patch } });
const reply = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const unknown = error => error instanceof OtpSmsError && error.code === 'SMS_OUTCOME_UNKNOWN' && error.definitive === false && error.statusCode === 503;
const rejected = error => error instanceof OtpSmsError && error.code === 'SMS_REJECTED' && error.definitive === true && error.statusCode === 503;

test('SMS configuration defaults to demo only outside production and real sending requires explicit opt-in', () => {
  assert.deepEqual(getSmsConfiguration({ NODE_ENV: 'test' }), { kind: 'demo' });
  assert.deepEqual(getSmsConfiguration({ NODE_ENV: 'development', TEZJET_SMS_PROVIDER: 'demo' }), { kind: 'demo' });
  for (const value of [{ NODE_ENV: 'production' }, { NODE_ENV: 'production', TEZJET_SMS_PROVIDER: 'demo' }, env({ TEZJET_SMS_SEND_ENABLED: undefined }), env({ TEZJET_SMS_SEND_ENABLED: 'false' }), env({ TEZJET_SMS_PROVIDER: 'unknown' })]) {
    assert.throws(() => getSmsConfiguration(value), error => error.code === 'SMS_NOT_CONFIGURED' && error.statusCode === 503);
  }
  assert.deepEqual(config(), { kind: 'devsms', apiKey: key, serviceName: 'Onay', timeoutMs: 8000 });
});
test('configuration rejects header injection, invalid service names and unsafe deadlines without exposing values', () => {
  for (const patch of [{ DEVSMS_API_KEY: '' }, { DEVSMS_API_KEY: `${key}\r\nx-injected: private` }, { DEVSMS_API_KEY: `${key}\n` }, { DEVSMS_API_KEY: 'two tokens' }, { TEZJET_SMS_SERVICE_NAME: 'x' }, { TEZJET_SMS_SERVICE_NAME: '<Onay>' }, { TEZJET_SMS_SERVICE_NAME: ' ' }, { TEZJET_SMS_TIMEOUT_MS: '999' }, { TEZJET_SMS_TIMEOUT_MS: '15001' }, { TEZJET_SMS_TIMEOUT_MS: '1000.5' }]) {
    assert.throws(() => config(patch), error => {
      assert.equal(error.code, 'SMS_NOT_CONFIGURED');
      assert.equal(JSON.stringify(error).includes(key), false);
      return true;
    });
  }
  assert.equal(config({ TEZJET_SMS_TIMEOUT_MS: '1000' }).timeoutMs, 1000);
  assert.equal(config({ TEZJET_SMS_TIMEOUT_MS: '15000', TEZJET_SMS_SERVICE_NAME: 'Onay 2.0' }).timeoutMs, 15000);
});
test('one server-side request uses exact DevSMS v1 OTP contract and a stable idempotency key', async () => {
  let calls = 0;
  const result = await sendOtpSms(config(), input(), async (url, options) => {
    calls++; assert.equal(url, 'https://devsms.uz/api/v1/sms');
    assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit'); assert.equal(options.cache, 'no-store');
    assert.equal(options.headers.Authorization, `Bearer ${key}`); assert.equal(options.headers.Accept, 'application/json');
    assert.equal(options.headers['Content-Type'], 'application/json'); assert.equal(options.headers['Idempotency-Key'], deliveryId);
    assert.deepEqual(JSON.parse(options.body), { phone: phone.slice(1), otp: { template_type: 4, service_name: 'Onay', code } });
    return reply(good());
  });
  assert.equal(calls, 1); assert.deepEqual(result, { providerMessageId: '123', status: 'accepted' });
  assert.deepEqual(Object.keys(result).sort(), ['providerMessageId', 'status']);
});
test('pending and sent mean accepted; only an explicit delivered status means handset delivery', async () => {
  for (const status of ['pending', 'sent', 'delivered']) {
    const result = await sendOtpSms(config(), input(), async () => reply(good({ status })));
    assert.equal(result.status, status === 'delivered' ? 'delivered' : 'accepted');
  }
});
test('invalid destinations, codes and UUIDs are rejected before any provider request', async () => {
  for (const patch of [{ phoneNumber: '+77771234567' }, { phoneNumber: '998901234567' }, { phoneNumber: '+99890123456' }, { code: '12345' }, { code: '12345x' }, { deliveryId: 'not-a-uuid' }]) {
    let calls = 0;
    await assert.rejects(sendOtpSms(config(), { ...input(), ...patch }, async () => { calls++; throw new Error('Must not send'); }), rejected);
    assert.equal(calls, 0);
  }
});
test('documented definitive provider rejections are sanitized and never retried', async () => {
  for (const [status, errorCode] of [[401, 'unauthenticated'], [401, 'token_expired'], [402, 'insufficient_balance'], [403, 'forbidden'], [403, 'account_blocked'], [403, 'moderation_rejected'], [403, 'otp_suspended'], [422, 'validation_failed'], [422, 'provider_rejected']]) {
    let calls = 0;
    await assert.rejects(sendOtpSms(config(), input(), async () => { calls++; return reply({ success: false, error_code: errorCode, message: `${key} ${phone} ${code}`, meta: { charged: false } }, status); }), error => {
      assert.equal(rejected(error), true);
      for (const secret of [key, phone, code]) assert.equal(`${error.stack} ${JSON.stringify(error)}`.includes(secret), false);
      assert.equal(Object.hasOwn(error, 'cause'), false); return true;
    });
    assert.equal(calls, 1);
  }
});
test('charged errors, conflicts, throttling and ambiguous failures remain unknown without retry', async () => {
  for (const [status, body] of [[400, { success: false, charged: true }], [422, { success: false, error_code: 'provider_rejected', meta: { charged: true } }], [200, { ...good(), meta: { charged: true } }], [409, { success: false, error_code: 'idempotency_request_in_progress' }], [429, { success: false, error_code: 'rate_limited' }], [502, { success: false, error_code: 'provider_outcome_unknown', meta: { charged: true, sms_id: 123 } }], [500, { success: false, error_code: 'server_error' }], [401, { success: false, error_code: 'unknown_new_error' }]]) {
    let calls = 0;
    await assert.rejects(sendOtpSms(config(), input(), async () => { calls++; return reply(body, status); }), unknown);
    assert.equal(calls, 1);
  }
});
test('malformed or inconsistent successful responses cannot report acceptance', async () => {
  for (const body of [null, {}, [], { success: 'true', data: good().data }, good({ phone: '998909999999' }), good({ id: 0 }), good({ id: '123' }), good({ status: 'failed' }), good({ error: 'upstream failure' }), good({ outcome: 'unknown' }), good({ status: 'unrecognized' })]) {
    await assert.rejects(sendOtpSms(config(), input(), async () => reply(body)), unknown);
  }
  await assert.rejects(sendOtpSms(config(), input(), async () => new Response('<html>upstream error</html>')), unknown);
  await assert.rejects(sendOtpSms(config(), input(), async () => reply(good(), 202)), unknown);
});
test('redirects and raw transport errors cannot leak credentials or trigger another attempt', async () => {
  let calls = 0;
  await assert.rejects(sendOtpSms(config(), input(), async (_url, options) => { calls++; assert.equal(options.redirect, 'error'); throw new Error(`${key} ${phone} ${code}`); }), error => {
    assert.equal(unknown(error), true);
    for (const secret of [key, phone, code]) assert.equal(`${error.stack} ${JSON.stringify(error)}`.includes(secret), false);
    return true;
  });
  assert.equal(calls, 1);
  await assert.rejects(sendOtpSms(config(), input(), async () => new Response(null, { status: 302, headers: { location: 'https://untrusted.invalid' } })), unknown);
});
test('provider body buffering is bounded by actual bytes and declared length', async () => {
  await assert.rejects(sendOtpSms(config(), input(), async () => reply(good(), 200, { 'content-length': String(65537) })), unknown);
  await assert.rejects(sendOtpSms(config(), input(), async () => reply({ ...good(), padding: 'x'.repeat(65536) })), unknown);
  await assert.rejects(sendOtpSms(config(), input(), async () => reply({ ...good(), padding: '😀'.repeat(20000) })), unknown);
  await assert.rejects(sendOtpSms(config(), input(), async () => reply(good(), 200, { 'content-length': 'not-a-length' })), unknown);
});
test('deadline aborts a provider that does not return headers without retry', { timeout: 5000 }, async () => {
  let calls = 0, signal;
  await assert.rejects(sendOtpSms(config({ TEZJET_SMS_TIMEOUT_MS: '1000' }), input(), async (_url, options) => {
    calls++; signal = options.signal; return await new Promise(() => {});
  }), unknown);
  assert.equal(calls, 1); assert.equal(signal.aborted, true);
});
test('deadline includes a stalled response body and cancels its reader', { timeout: 5000 }, async () => {
  let cancelled = false, signal;
  await assert.rejects(sendOtpSms(config({ TEZJET_SMS_TIMEOUT_MS: '1000' }), input(), async (_url, options) => {
    signal = options.signal;
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  }), unknown);
  assert.equal(signal.aborted, true); assert.equal(cancelled, true);
});
