import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canJoinLegacyDriverQueue, canMutateDriverRoute, createDriverRouteClient, createDriverRouteRequestScope,
  driverDirectionLabel, DriverRouteError, driverRouteSaveInput, driverRouteSessionKey, orderedDriverStops,
  parseDriverRouteCatalog, parseDriverRouteSnapshot, refreshDriverRouteDraft,
} from "../lib/driver-routes.ts";

const version = "2026-10-14T10:00:00.000Z";
const route = {
  id: "route-1", name: "Маршрут администратора", updatedAt: version,
  stops: [
    { id: "one", code: "START", name: "Северный вокзал", sequence: 1, position: 1 },
    { id: "two", code: "MID", name: "Центральный рынок", sequence: 2, position: 2 },
    { id: "three", code: "END", name: "Южный парк", sequence: 3, position: 3 },
  ],
  pitaks: { aStopCode: "START", bStopCode: "END", radiusMeters: 200 },
};
const choice = { routeId: route.id, direction: "b_to_a", routeUpdatedAt: version };
const saved = { choice, route, unavailable_reason: null };
const empty = { choice: null, route: null, unavailable_reason: null };
const response = (body, status = 200) => new Response(JSON.stringify(body), { status });
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const invalid = error => error instanceof DriverRouteError && error.code === "INVALID_RESPONSE";

test("catalog validates configured endpoints and ordered unique stops without repairing malformed data", () => {
  assert.deepEqual(parseDriverRouteCatalog({ routes: [route] }), [route]);
  for (const bad of [
    { ...route, id: "" }, { ...route, name: " " }, { ...route, updatedAt: "" },
    { ...route, stops: [] }, { ...route, stops: [...route.stops].reverse() },
    { ...route, pitaks: null }, { ...route, pitaks: { ...route.pitaks, aStopCode: "MID" } },
    { ...route, pitaks: { ...route.pitaks, bStopCode: "MISSING" } },
    { ...route, pitaks: { ...route.pitaks, radiusMeters: 0 } },
    ...["id", "code"].map(field => ({ ...route, stops: route.stops.map((stop, index) => index === 1 ? { ...stop, [field]: route.stops[0][field] } : stop) })),
    ...[0, NaN, 1.5, "2"].map(sequence => ({ ...route, stops: route.stops.map((stop, index) => index === 1 ? { ...stop, sequence } : stop) })),
    { ...route, stops: route.stops.map((stop, index) => index === 1 ? { ...stop, position: 1 } : stop) },
  ]) assert.throws(() => parseDriverRouteCatalog({ routes: [bad] }), invalid);
  assert.throws(() => parseDriverRouteCatalog({ routes: [route, route] }), invalid);
});

test("both directions show actual endpoint names and reverse the stop order without mutating the route", () => {
  assert.equal(driverDirectionLabel(route, "a_to_b"), "A → B: Северный вокзал → Южный парк");
  assert.equal(driverDirectionLabel(route, "b_to_a"), "B → A: Южный парк → Северный вокзал");
  assert.deepEqual(orderedDriverStops(route, "a_to_b").map(stop => stop.code), ["START", "MID", "END"]);
  assert.deepEqual(orderedDriverStops(route, "b_to_a").map(stop => stop.code), ["END", "MID", "START"]);
  assert.deepEqual(route.stops.map(stop => stop.code), ["START", "MID", "END"]);
});

test("snapshots retain unavailable persisted choices and reject inconsistent success responses", () => {
  assert.deepEqual(parseDriverRouteSnapshot(empty), empty);
  assert.deepEqual(parseDriverRouteSnapshot(saved), saved);
  for (const reason of ["ROUTE_MISSING", "ROUTE_INACTIVE", "ROUTE_CHANGED", "ROUTE_NOT_CONFIGURED"]) {
    const unavailable = { choice, route: null, unavailable_reason: reason };
    assert.deepEqual(parseDriverRouteSnapshot(unavailable), unavailable);
    assert.throws(() => parseDriverRouteSnapshot({ ...saved, unavailable_reason: reason }), invalid);
  }
  for (const bad of [
    {}, { ...saved, choice: { ...choice, direction: "sideways" } },
    { ...saved, choice: { ...choice, routeId: "another" } },
    { ...saved, choice: { ...choice, routeUpdatedAt: "older" } },
    { ...saved, route: null }, { ...saved, unavailable_reason: "UNKNOWN" },
    { ...empty, route }, { ...empty, unavailable_reason: "ROUTE_CHANGED" },
  ]) assert.throws(() => parseDriverRouteSnapshot(bad), invalid);
});

test("out-of-date catalog requires refresh; refreshed draft keeps its route and direction for explicit retry", () => {
  const newer = { ...route, updatedAt: "2026-10-14T11:00:00.000Z", stops: route.stops.map(stop => ({ ...stop, name: `${stop.name} новый` })) };
  assert.throws(() => driverRouteSaveInput(choice, [newer]), error => error.code === "ROUTE_CHANGED");
  const refreshed = refreshDriverRouteDraft(choice, [newer]);
  assert.equal(refreshed.routeId, choice.routeId);
  assert.equal(refreshed.direction, "b_to_a");
  assert.deepEqual(driverRouteSaveInput(refreshed, [newer]), { route_id: choice.routeId, direction: "b_to_a", expected_updated_at: newer.updatedAt });
  assert.deepEqual(refreshDriverRouteDraft(choice, []), choice, "missing drafts are retained for explicit reselection");
  assert.throws(() => driverRouteSaveInput(choice, []), error => error.code === "VALIDATION_ERROR");
  assert.throws(() => driverRouteSaveInput(null, [route]), error => error.code === "VALIDATION_ERROR");
  assert.throws(() => driverRouteSaveInput({ ...choice, direction: "unknown" }, [route]), error => error.code === "VALIDATION_ERROR");
});

test("legacy queue only opens after the current endpoint and session confirm no persisted choice", () => {
  const sessionKey = driverRouteSessionKey("https://first.example", "token-1");
  const gate = { sessionKey, ready: true, hasChoice: false, mutating: false };
  assert.equal(canJoinLegacyDriverQueue(gate, sessionKey), true);
  for (const change of [{ ready: false }, { hasChoice: true }, { mutating: true }]) {
    assert.equal(canJoinLegacyDriverQueue({ ...gate, ...change }, sessionKey), false);
  }
  assert.equal(canJoinLegacyDriverQueue(gate, driverRouteSessionKey("https://second.example", "token-1")), false);
  assert.equal(canJoinLegacyDriverQueue(gate, driverRouteSessionKey("https://first.example", "token-2")), false);
  const idle = { busy: false, queued: false, activeTrip: false, pendingOffer: false };
  assert.equal(canMutateDriverRoute(idle), true);
  for (const field of Object.keys(idle)) assert.equal(canMutateDriverRoute({ ...idle, [field]: true }), false, field);
});

test("client starts independent GETs together and persists authenticated choices with the catalog version", async () => {
  const catalog = deferred(), snapshot = deferred(), calls = [];
  const client = createDriverRouteClient("https://api.example", "driver-token", async (url, init) => {
    calls.push({ url, init });
    if (init.method === "PUT") return response(saved);
    if (init.method === "DELETE") return new Response(null, { status: 204 });
    return url.endsWith("/routes") ? catalog.promise : snapshot.promise;
  });
  const controller = new AbortController();
  const pending = client.load(controller.signal);
  assert.deepEqual(calls.map(call => call.url), ["https://api.example/api/driver/routes", "https://api.example/api/driver/route"]);
  catalog.resolve(response({ routes: [route] })); snapshot.resolve(response(saved));
  assert.deepEqual(await pending, { routes: [route], snapshot: saved });
  assert.deepEqual(await client.save(choice, [route], controller.signal), saved);
  assert.deepEqual(JSON.parse(calls[2].init.body), { route_id: route.id, direction: "b_to_a", expected_updated_at: version });
  assert.equal(await client.clear(controller.signal), undefined);
  assert.equal(calls[3].init.method, "DELETE");
  assert.ok(calls.every(call => call.init.headers.Authorization === "Bearer driver-token"));
});

test("stale and busy server failures remain typed and never auto-retry or clear a persisted choice", async () => {
  for (const code of ["ROUTE_CHANGED", "DRIVER_ROUTE_BUSY"]) {
    let calls = 0;
    const client = createDriverRouteClient("https://api.example", "driver", async () => {
      calls += 1;
      return response({ error: { code, message: "Conflict" } }, 409);
    });
    await assert.rejects(client.save(choice, [route], new AbortController().signal), error => error instanceof DriverRouteError && error.status === 409 && error.code === code);
    assert.equal(calls, 1);
    assert.deepEqual(choice, saved.choice);
  }
  const malformed = createDriverRouteClient("https://api.example", "driver", async () => response(empty));
  await assert.rejects(malformed.save(choice, [route], new AbortController().signal), invalid);
});

test("request scope aborts superseded reads and refuses late response application or stale draft restoration", async () => {
  const oldCatalog = deferred(), oldSnapshot = deferred();
  let applied = null, callCount = 0;
  const client = createDriverRouteClient("https://old.example", "old-session", async () => {
    callCount += 1;
    return callCount === 1 ? oldCatalog.promise : oldSnapshot.promise;
  });
  const scope = createDriverRouteRequestScope();
  const oldTicket = scope.start();
  const oldLoad = client.load(oldTicket.signal).then(value => {
    if (scope.isCurrent(oldTicket)) applied = value;
  }).catch(error => { assert.equal(error.code, "REQUEST_ABORTED"); });
  scope.editDraft();
  assert.equal(scope.draftUnchanged(oldTicket), false);
  const newTicket = scope.start();
  assert.equal(oldTicket.signal.aborted, true);
  assert.equal(scope.isCurrent(oldTicket), false);
  assert.equal(scope.isCurrent(newTicket), true);
  oldCatalog.resolve(response({ routes: [route] })); oldSnapshot.resolve(response(saved));
  await oldLoad;
  assert.equal(applied, null);
  scope.dispose();
  assert.equal(scope.isCurrent(newTicket), false);
  assert.equal(newTicket.signal.aborted, true);
});

test("late PUT responses from a disposed session cannot reopen the new session's queue", async () => {
  const pendingWrite = deferred();
  let transportSignal;
  const oldClient = createDriverRouteClient("https://old.example", "old-session", async (_url, init) => {
    transportSignal = init.signal;
    return pendingWrite.promise;
  });
  const scope = createDriverRouteRequestScope(), ticket = scope.start();
  const nextKey = driverRouteSessionKey("https://new.example", "new-session");
  let gate = { sessionKey: nextKey, ready: false, hasChoice: false, mutating: false };
  const write = oldClient.save(choice, [route], ticket.signal).then(result => {
    if (scope.isCurrent(ticket)) gate = { sessionKey: nextKey, ready: true, hasChoice: result.choice != null, mutating: false };
  }).catch(error => { assert.equal(error.code, "REQUEST_ABORTED"); });
  scope.dispose();
  assert.equal(transportSignal.aborted, true);
  pendingWrite.resolve(response(saved));
  await write;
  assert.equal(canJoinLegacyDriverQueue(gate, nextKey), false);
  assert.equal(gate.ready, false);
});

test("network failures never look like a successful empty restored choice", async () => {
  const client = createDriverRouteClient("https://api.example", "driver", async () => { throw new TypeError("offline"); });
  await assert.rejects(client.load(new AbortController().signal), error => error.code === "NETWORK_ERROR");
});
