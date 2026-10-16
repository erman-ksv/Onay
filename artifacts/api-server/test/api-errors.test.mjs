import { withoutApplicationEnvironment } from "./environment.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { get } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { io as createSocket } from "socket.io-client";

// Real Express, production JSON logging, Socket.IO, and mandatory PostgreSQL.
// SQL failures are generated inside our private schema, never by mocking SQL.
const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { Pool } = createRequire(new URL("../../../lib/db/package.json", import.meta.url))("pg");
const schema = `api_errors_${randomUUID().replaceAll("-", "")}`;
const emptySchema = `${schema}_startup`;
const tables = ["tezjet_users", "tezjet_otp_challenges", "otp_rate_limits", "tezjet_driver_queue", "tezjet_orders", "tezjet_device_registrations", "tezjet_routes"];
const secret = "api-errors-production-regression-secret-at-least-32-characters";
const sentinels = {
  query: "PRIVATE_QUERY_SENTINEL", path: "PRIVATE_PATH_SENTINEL", header: "PRIVATE_HEADER_SENTINEL",
  body: "PRIVATE_BODY_SENTINEL", upstream: "PRIVATE_UPSTREAM_SENTINEL", sql: "PRIVATE_SQL_SENTINEL",
  parameter: "PRIVATE_PARAMETER_SENTINEL", cause: "PRIVATE_CAUSE_SENTINEL", stack: "PRIVATE_STACK_SENTINEL",
  otp: "PRIVATE_OTP_SENTINEL", address: "PRIVATE_ADDRESS_SENTINEL", code: "PRIVATE_CODE_SENTINEL",
};
const forbidden = [...Object.values(sentinels), secret];
let adminPool;
let child;
let directory;
let fixture;
let baseUrl;
let isolatedDatabaseUrl;
let output = "";
let errors = "";
let schemaCreated = false;
let emptySchemaCreated = false;
let commandSequence = 0;
const replies = new Map();

const fixtureSource = `
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import express from "express";
import app from "./src/app";
import { store } from "./src/store";
import { PostgresStore } from "./src/store/postgresStore";
import { pool } from "../../lib/db/src/index";
import { createAccessToken } from "./src/utils/token";
import { AppError, toPublicError, serializeSafeError } from "./src/utils/errors";
import { errorHandler } from "./src/middleware/errorHandler";
import { logger } from "./src/lib/logger";
import { createRealtimeServer } from "./src/socket";
const sentinels = ${JSON.stringify(sentinels)};
let providerMode = "upstream";
globalThis.fetch = async (_url, options) => {
  if (providerMode === "network") throw new Error(sentinels.upstream);
  if (providerMode === "timeout") throw new DOMException(sentinels.upstream, "AbortError");
  if (providerMode === "body-timeout") return { ok: true, async json() { throw new DOMException(sentinels.upstream, "AbortError"); } };
  if (providerMode === "empty") return Response.json({ candidates: [] });
  if (providerMode === "null-payload") return Response.json(null);
  if (providerMode === "array-payload") return Response.json([]);
  if (providerMode === "invalid-payload") return new Response(sentinels.upstream, { headers: { "content-type": "application/json" } });
  if (providerMode === "invalid-result") return Response.json({ candidates: [{ content: { parts: [{ text: sentinels.upstream }] } }] });
  if (providerMode === "not-configured") throw new Error("fetch must not be called without configuration");
  if (providerMode === "upstream-unreadable") {
    return { ok: false, status: 429, body: { async cancel() {} }, async text() { throw new Error("Upstream body must not be read"); } };
  }
  return new Response(sentinels.upstream + " address=" + sentinels.address, { status: 429 });
};
assert.ok(store instanceof PostgresStore);
await store.initialize();
const user = await store.createUser({ role: "passenger", fullName: "Error regression passenger", phoneNumber: "+77000000001", locale: "ru" });
const admin = await store.createUser({ role: "admin", fullName: "Error regression administrator", phoneNumber: "+77000000002", locale: "ru" });
const driver = await store.createUser({ role: "driver", fullName: "Error regression driver", phoneNumber: "+77000000003", locale: "ru" });
await store.setDriverApproval(driver.id, "approved");
const sign = user => createAccessToken({ sub: user.id, role: user.role, locale: user.locale, sessionVersion: user.sessionVersion, sessionId: randomUUID() });
const server = createServer(app);
const io = createRealtimeServer(server);
app.locals.io = io;
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const partialApp = express();
partialApp.get("/partial", (_request, response, next) => {
  response.write("partial response");
  const error = new Error(sentinels.sql, { cause: new Error(sentinels.cause) });
  error.stack = sentinels.stack;
  next(error);
});
partialApp.use(errorHandler);
const partialServer = createServer(partialApp);
await new Promise(resolve => partialServer.listen(0, "127.0.0.1", resolve));
process.send({ type: "ready", port: server.address().port, partialPort: partialServer.address().port, userId: user.id, token: sign(user), adminToken: sign(admin), driverToken: sign(driver) });
process.on("message", async message => {
  try {
    let result;
    if (message.command === "provider") {
      providerMode = message.mode;
      if (providerMode === "not-configured") delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = sentinels.header;
    } else if (message.command === "sign") {
      result = sign({ ...user, id: message.sub });
    } else if (message.command === "headers-sent") {
      const raw = new Error(sentinels.sql, { cause: new Error(sentinels.cause) });
      raw.stack = sentinels.stack;
      let calls = 0;
      let mutations = 0;
      let delegated;
      errorHandler(raw, { method: "GET", url: "/" + sentinels.path }, { headersSent: true, status() { mutations++; return this; }, json() { mutations++; }, setHeader() { mutations++; } }, error => { calls++; delegated = error; });
      result = { calls, mutations, original: delegated === raw, message: delegated?.message, stack: delegated?.stack, cause: delegated?.cause };
    } else if (message.command === "classify") {
      const publicError = toPublicError(message.error);
      result = { status: publicError.statusCode, code: publicError.code, message: publicError.message };
    } else if (message.command === "logger") {
      const raw = new Error(sentinels.sql, { cause: new Error(sentinels.cause) });
      raw.stack = sentinels.stack;
      raw.query = "SELECT " + sentinels.sql;
      raw.params = [sentinels.parameter];
      raw.token = sentinels.header;
      raw.code = sentinels.code;
      raw.name = sentinels.code;
      logger.error({ err: raw }, "Regression safe structured error");
      const appError = new AppError(502, sentinels.upstream, "GEMINI_UPSTREAM_ERROR");
      const publicError = toPublicError(appError);
      result = { status: publicError.statusCode, code: publicError.code, message: publicError.message, serialized: serializeSafeError(raw) };
    } else if (message.command === "flush") {
      await new Promise(resolve => logger.flush(resolve));
    }
    process.send({ type: "reply", id: message.id, result });
  } catch {
    process.send({ type: "reply", id: message.id, error: "Fixture command failed" });
  }
});
process.on("disconnect", async () => {
  await new Promise(resolve => io.close(resolve));
  await new Promise(resolve => partialServer.close(resolve));
  await pool.end();
});
`;

function command(commandName, values = {}) {
  const id = ++commandSequence;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { replies.delete(id); reject(new Error(`Fixture command ${commandName} timed out`)); }, 5_000);
    replies.set(id, message => {
      clearTimeout(timeout);
      replies.delete(id);
      if (message.error) reject(new Error(message.error));
      else resolve(message.result);
    });
    child.send({ id, command: commandName, ...values });
  });
}

function privateUrl(original, searchPath) {
  const url = new URL(original);
  url.searchParams.set("options", `${url.searchParams.get("options") ?? ""} -c search_path=${searchPath}`.trim());
  return url.href;
}

before(async () => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required: safe-error regressions must execute real PostgreSQL.");
  adminPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  schemaCreated = true;
  for (const table of tables) await adminPool.query(`CREATE TABLE "${schema}"."${table}" (LIKE "public"."${table}" INCLUDING ALL)`);
  isolatedDatabaseUrl = privateUrl(process.env.DATABASE_URL, schema);
  directory = await mkdtemp(path.join(apiRoot, ".api-errors-test-"));
  const entry = path.join(directory, "production.mjs");
  await build({
    stdin: { contents: fixtureSource, resolveDir: apiRoot, loader: "ts" },
    outfile: entry, bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "silent",
    external: ["pg-native", "pino", "pino-http", "socket.io"],
    banner: { js: 'import { createRequire as testCreateRequire } from "node:module"; const require = testCreateRequire(import.meta.url);' },
  });
  child = spawn(process.execPath, [entry], {
    cwd: apiRoot,
    env: { ...withoutApplicationEnvironment(), NODE_ENV: "production", LOG_LEVEL: "info", DATABASE_URL: isolatedDatabaseUrl, ONAY_STORAGE_ADAPTER: "postgres", SESSION_SECRET: secret, GEMINI_API_KEY: sentinels.header },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", data => { output += data; });
  child.stderr.on("data", data => { errors += data; });
  child.on("message", message => { if (message.type === "reply") replies.get(message.id)?.(message); });
  fixture = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Production error fixture did not start")), 20_000);
    child.once("error", reject);
    child.once("exit", code => reject(new Error(`Production error fixture exited ${code}: ${errors}`)));
    child.on("message", message => { if (message.type === "ready") { clearTimeout(timeout); resolve(message); } });
  });
  forbidden.push(fixture.token, fixture.adminToken, fixture.driverToken);
  baseUrl = `http://127.0.0.1:${fixture.port}`;
}, { timeout: 30_000 });

after(async () => {
  try {
    if (child && child.exitCode === null) {
      const exited = new Promise(resolve => child.once("exit", resolve));
      child.kill("SIGTERM");
      await exited;
    }
    if (schemaCreated) await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
    if (emptySchemaCreated) await adminPool.query(`DROP SCHEMA "${emptySchema}" CASCADE`);
  } finally {
    if (adminPool) await adminPool.end();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

async function request(route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    ...options,
    headers: { ...(options.body ? { "content-type": "application/json" } : {}), ...options.headers },
  });
  const text = await response.text();
  return { response, text, body: text ? JSON.parse(text) : undefined };
}

function assertError(result, status, code, message) {
  assert.equal(result.response.status, status);
  assert.match(result.response.headers.get("content-type") ?? "", /application\/json/);
  assert.equal(result.body.error.code, code);
  if (message) assert.equal(result.body.error.message, message);
  assert.match(result.body.request_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.equal(result.response.headers.get("x-request-id"), result.body.request_id);
  for (const value of forbidden) assert.ok(!result.text.includes(value), `Public response leaked sentinel ${value}`);
}

async function assertPrivateLogs() {
  await command("flush");
  // The stdout pipe and IPC reply are separate streams; yield for the pipe.
  await new Promise(resolve => setTimeout(resolve, 20));
  for (const value of forbidden) {
    assert.ok(!output.includes(value), `Production JSON log leaked sentinel ${value}`);
    assert.ok(!errors.includes(value), `Production stderr leaked sentinel ${value}`);
  }
  return output.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
}

test("malformed JSON returns correlated 400 while body, headers, and caller request ID stay private", async () => {
  const result = await request(`/api/auth/request-otp?key=${sentinels.query}`, {
    method: "POST", body: `{ "code": "${sentinels.otp}", "address": "${sentinels.address}"`,
    headers: { authorization: `Bearer ${sentinels.header}`, cookie: `session=${sentinels.header}`, "x-request-id": sentinels.header },
  });
  assertError(result, 400, "INVALID_JSON", "Invalid JSON body");
  assert.notEqual(result.body.request_id, sentinels.header);
  const logs = await assertPrivateLogs();
  assert.ok(logs.some(log => log.request_id === result.body.request_id || log.req?.id === result.body.request_id), "Server-generated request ID must correlate a public failure with its production log.");
  assert.equal((await request("/api/healthz")).response.status, 200);
});

test("oversized JSON and URL-encoded bodies return 413 before controllers", async () => {
  for (const [contentType, body] of [
    ["application/json", JSON.stringify({ address: sentinels.body + "a".repeat(110_000) })],
    ["application/x-www-form-urlencoded", `address=${sentinels.body}${"a".repeat(110_000)}`],
  ]) {
    assertError(await request("/api/auth/request-otp", { method: "POST", body, headers: { "content-type": contentType } }), 413, "PAYLOAD_TOO_LARGE");
  }
  await assertPrivateLogs();
});

test("unsupported charset or content encoding returns safe 415", async () => {
  for (const headers of [
    { "content-type": "application/json; charset=iso-8859-1" },
    { "content-type": "application/json", "content-encoding": sentinels.header },
  ]) assertError(await request("/api/auth/request-otp", { method: "POST", body: JSON.stringify({ address: sentinels.body }), headers }), 415, "UNSUPPORTED_MEDIA_TYPE");
  await assertPrivateLogs();
});

test("unknown API paths return JSON404 and dynamic paths never enter production logs", async () => {
  const result = await request(`/api/${sentinels.path}?api_key=${sentinels.query}`);
  assertError(result, 404, "NOT_FOUND", "API endpoint not found");
  assert.equal((await request("/api/healthz")).response.status, 200);
  await assertPrivateLogs();
});

test("invalid percent-encoded route parameters return a safe 400", async () => {
  assertError(await request("/api/admin/routes/%E0%A4%A"), 400, "INVALID_REQUEST_PATH");
  await assertPrivateLogs();
});

test("existing validation, auth, access, conflict, and not-found error contracts survive", async () => {
  assertError(await request("/api/auth/request-otp", { method: "POST", body: "{}" }), 400, "VALIDATION_ERROR", "phone_number is required");
  assertError(await request("/api/auth/me"), 401, "UNAUTHORIZED");
  assertError(await request("/api/admin/routes", { headers: { authorization: `Bearer ${fixture.token}` } }), 403, "FORBIDDEN", "You do not have permission for this operation");
  assertError(await request("/api/auth/profile", { method: "PATCH", body: JSON.stringify({ full_name: "Different name" }), headers: { authorization: `Bearer ${fixture.token}` } }), 409, "PROFILE_LOCKED");
  assertError(await request(`/api/admin/routes/${sentinels.path}`, { headers: { authorization: `Bearer ${fixture.adminToken}` } }), 404, "ROUTE_NOT_FOUND", "Route not found");
  assertError(await request(`/api/fares/stops?route_id=${sentinels.query}`, { headers: { authorization: `Bearer ${fixture.token}` } }), 404, "ROUTE_NOT_FOUND", "Route was not found");
  assertError(await request("/api/queue/join", { method: "POST", body: JSON.stringify({ location: { lat: 100, lng: 0 } }), headers: { authorization: `Bearer ${fixture.driverToken}` } }), 422, "INVALID_COORDINATES", "Invalid coordinates");
  await assertPrivateLogs();
});

test("real Drizzle lookup failure hides SQL and parameters in HTTP and Socket.IO, then recovers", { timeout: 15_000 }, async () => {
  const token = await command("sign", { sub: sentinels.parameter });
  forbidden.push(token);
  await adminPool.query(`ALTER TABLE "${schema}".tezjet_users RENAME TO missing_users`);
  try {
    assertError(await request(`/api/auth/me?token=${sentinels.query}`, { headers: { authorization: `Bearer ${token}` } }), 500, "INTERNAL_SERVER_ERROR", "Internal server error");
    const socket = createSocket(baseUrl, { path: "/api/socket.io", auth: { token }, transports: ["websocket"], autoConnect: false, reconnection: false });
    try {
      const error = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Socket rejection timed out")), 5_000);
        socket.once("connect_error", error => { clearTimeout(timeout); resolve(error); });
        socket.connect();
      });
      assert.equal(error.message, "Authentication unavailable");
      assert.equal(socket.connected, false);
      assert.ok(!JSON.stringify(error).includes(sentinels.parameter));
    } finally { socket.disconnect(); }
    const logs = await assertPrivateLogs();
    assert.ok(logs.some(log => log.err?.category === "database"), "Actual PostgreSQL failures must remain diagnostically classified.");
    assert.ok(logs.some(log => log.msg === "Socket authentication failed"));
    assert.equal((await request("/api/healthz")).response.status, 200);
  } finally { await adminPool.query(`ALTER TABLE "${schema}".missing_users RENAME TO tezjet_users`); }
  assert.equal((await request("/api/auth/me", { headers: { authorization: `Bearer ${fixture.token}` } })).response.status, 200);
});

test("real PostgreSQL conflict and availability errors have stable HTTP mappings and no private diagnostics", async () => {
  const functionName = "reject_profile";
  await adminPool.query(`CREATE FUNCTION "${schema}"."${functionName}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = '${sentinels.sql}', DETAIL = '${sentinels.parameter}'; END $$`);
  await adminPool.query(`CREATE TRIGGER reject_profile BEFORE UPDATE ON "${schema}".tezjet_users FOR EACH ROW EXECUTE FUNCTION "${schema}"."${functionName}"()`);
  try {
    for (const [state, status, code] of [
      ["23505", 409, "RESOURCE_CONFLICT"], ["40001", 409, "REQUEST_CONFLICT"], ["40P01", 409, "REQUEST_CONFLICT"],
      ["08006", 503, "SERVICE_UNAVAILABLE"], ["57P03", 503, "SERVICE_UNAVAILABLE"], ["P0001", 500, "INTERNAL_SERVER_ERROR"],
    ]) {
      await adminPool.query(`CREATE OR REPLACE FUNCTION "${schema}"."${functionName}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION USING ERRCODE = '${state}', MESSAGE = '${sentinels.sql}', DETAIL = '${sentinels.parameter}'; END $$`);
      const result = await request("/api/auth/profile", { method: "PATCH", body: JSON.stringify({ locale: "uz" }), headers: { authorization: `Bearer ${fixture.token}` } });
      assertError(result, status, code);
      if (status === 503) assert.equal(result.body.error.message, "Service temporarily unavailable");
    }
    await assertPrivateLogs();
  } finally {
    await adminPool.query(`DROP TRIGGER reject_profile ON "${schema}".tezjet_users`);
    await adminPool.query(`DROP FUNCTION "${schema}"."${functionName}"()`);
  }
  assert.equal((await request("/api/auth/profile", { method: "PATCH", body: JSON.stringify({ locale: "ru" }), headers: { authorization: `Bearer ${fixture.token}` } })).response.status, 200);
});

test("untrusted status and code properties cannot masquerade as public application errors", async () => {
  for (const error of [
    { status: 401, code: sentinels.code, message: sentinels.sql },
    { statusCode: 404, code: "NOT_FOUND", message: sentinels.sql },
    { type: "entity.parse.failed", status: 500, message: sentinels.body },
    { code: "23505", message: sentinels.sql },
  ]) {
    const result = await command("classify", { error });
    assert.deepEqual(result, { status: 500, code: "INTERNAL_SERVER_ERROR", message: "Internal server error" });
  }
});

test("production logger drops nested error details and public AppError5xx messages are fixed", async () => {
  const result = await command("logger");
  assert.equal(result.status, 502);
  assert.equal(result.code, "GEMINI_UPSTREAM_ERROR");
  assert.equal(result.message, "Upstream service unavailable");
  assert.equal(result.serialized.category, "internal");
  assert.equal(result.serialized.code, "INTERNAL_SERVER_ERROR");
  const logs = await assertPrivateLogs();
  const record = logs.find(log => log.msg === "Regression safe structured error");
  assert.ok(record);
  assert.deepEqual(record.err, result.serialized);
});

test("headers-sent errors delegate once with a sanitized Error and never mutate the response", async () => {
  const result = await command("headers-sent");
  assert.equal(result.calls, 1);
  assert.equal(result.mutations, 0);
  assert.equal(result.original, false);
  assert.equal(result.message, "Internal server error");
  assert.equal(result.stack, "Error: Internal server error");
  assert.equal(result.cause, undefined);
  await assertPrivateLogs();
});

test("Express final handling after a partial response never prints the original error to stderr", { timeout: 10_000 }, async () => {
  await new Promise((resolve, reject) => {
    const request = get(`http://127.0.0.1:${fixture.partialPort}/partial`, response => {
      response.resume();
      response.once("aborted", resolve);
      response.once("end", resolve);
      response.on("error", resolve);
    });
    request.setTimeout(5_000, () => { request.destroy(); reject(new Error("Partial-response regression timed out")); });
    request.on("error", error => error.code === "ECONNRESET" ? resolve() : reject(error));
  });
  await assertPrivateLogs();
  assert.match(errors, /Error: Internal server error/, "Express must receive and print only the sanitized delegated error.");
});

test("address provider failures preserve status and code without returning or logging upstream contents", async () => {
  for (const [mode, status, code] of [
    ["upstream", 502, "GEMINI_UPSTREAM_ERROR"], ["upstream-unreadable", 502, "GEMINI_UPSTREAM_ERROR"],
    ["empty", 502, "GEMINI_EMPTY_RESPONSE"], ["invalid-payload", 502, "GEMINI_INVALID_RESPONSE"],
    ["null-payload", 502, "GEMINI_INVALID_RESPONSE"], ["array-payload", 502, "GEMINI_INVALID_RESPONSE"],
    ["invalid-result", 502, "GEMINI_INVALID_RESPONSE"], ["network", 502, "GEMINI_CONNECTION_ERROR"],
    ["timeout", 504, "GEMINI_TIMEOUT"], ["body-timeout", 504, "GEMINI_TIMEOUT"], ["not-configured", 503, "GEMINI_NOT_CONFIGURED"],
  ]) {
    await command("provider", { mode });
    const result = await request(`/api/addresses/normalize?key=${sentinels.query}`, { method: "POST", body: JSON.stringify({ address: sentinels.address }), headers: { authorization: `Bearer ${fixture.token}` } });
    assertError(result, status, code);
    assert.equal(result.body.error.message, { 502: "Upstream service unavailable", 503: "Service temporarily unavailable", 504: "Upstream service timed out" }[status]);
  }
  await assertPrivateLogs();
});

test("actual server startup SQL failure exits cleanly with sanitized JSON logging", { timeout: 15_000 }, async () => {
  await adminPool.query(`CREATE SCHEMA "${emptySchema}"`);
  emptySchemaCreated = true;
  const startup = spawn(process.execPath, [path.join(apiRoot, "dist/index.mjs")], {
    cwd: apiRoot,
    env: { ...withoutApplicationEnvironment(), NODE_ENV: "production", LOG_LEVEL: "info", DATABASE_URL: privateUrl(process.env.DATABASE_URL, emptySchema), ONAY_STORAGE_ADAPTER: "postgres", SESSION_SECRET: secret, PORT: "34883" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  startup.stdout.setEncoding("utf8");
  startup.stderr.setEncoding("utf8");
  startup.stdout.on("data", data => { stdout += data; });
  startup.stderr.on("data", data => { stderr += data; });
  const exitCode = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { startup.kill("SIGKILL"); reject(new Error("Failed startup did not exit")); }, 8_000);
    startup.once("error", reject);
    startup.once("close", code => { clearTimeout(timeout); resolve(code); });
  });
  assert.equal(exitCode, 1);
  assert.equal(stderr, "");
  for (const value of [...forbidden, emptySchema, "insert into", "tezjet_routes", "params:"]) assert.ok(!stdout.includes(value), "Startup logs must omit database and environment details.");
  const logs = stdout.trim().split("\n").map(line => JSON.parse(line));
  assert.ok(logs.some(log => log.msg === "API startup failed" && log.err?.category === "database"));
});
