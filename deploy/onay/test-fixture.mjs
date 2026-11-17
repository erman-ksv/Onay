// Synthetic local fixtures through the actual authenticated HTTP API. No
// database row substitution, allocation override, SMS call or production path.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

function check(condition, label) { assert.ok(condition, "R06_INVARIANT:" + label); }
async function api(origin, pathname, { token, method = "GET", body, status = 200, key } = {}) {
  const response = await fetch(origin + "/api" + pathname, {
    method, signal: AbortSignal.timeout(10_000), headers: { "content-type": "application/json",
      ...(token ? { authorization: "Bearer " + token } : {}), ...(key ? { "Idempotency-Key": key } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  check(response.status === status, pathname.split("?")[0] + ":HTTP_" + response.status + "_EXPECTED_" + status);
  return text ? JSON.parse(text) : undefined;
}
async function login(origin, phoneNumber, role) {
  const challenge = await api(origin, "/auth/request-otp", { method: "POST", status: 202,
    body: { phone_number: phoneNumber, role, full_name: "SYNTHETIC R06 " + role, locale: "ru" } });
  check(/^\d{6}$/.test(challenge.demo_code), "development_otp_available_only_in_test_harness");
  const session = await api(origin, "/auth/verify-otp", { method: "POST",
    body: { phone_number: phoneNumber, code: challenge.demo_code } });
  check(session.user.role === role, "independent_account_role");
  return { id: session.user.id, token: session.access_token, phoneNumber, role };
}
const point = (route, code = "A") => ({ ...route.stops.find(stop => stop.code === code).location, timestamp: Date.now(), isMocked: false });
const selection = (route, reverse = false) => ({ route_id: route.id, direction: reverse ? "b_to_a" : "a_to_b", expected_updated_at: route.updatedAt });
const requestBody = route => ({ ...selection(route), pickup_stop_id: route.stops[0].id,
  destination_stop_id: route.stops.at(-1).id, pickup_location: point(route), seats: 2 });
async function ownQueue(origin, driver) { return (await api(origin, "/queue", { token: driver.token })).your_entry; }
function fare(frozen, price) {
  check(frozen.currency === "UZS" && frozen.pricePerStop === price && frozen.total === price * 2 &&
    !Object.hasOwn(frozen, "totalKzt") && !Object.hasOwn(frozen, "pricePerStopKzt"), "explicit_uzs_canonical_fare");
}

export async function bootstrapFixture(origin, { price, adminPhone, phone }) {
  await api(origin, "/healthz");
  const admin = await login(origin, adminPhone, "admin");
  const passenger = await login(origin, phone(), "passenger");
  const drivers = [];
  for (let index = 0; index < 3; index++) {
    const driver = await login(origin, phone(), "driver");
    const vehicle = await api(origin, "/driver/vehicle", { token: driver.token, method: "PUT", body: {
      make: "SYNTHETIC", model: "R06 TEST CAR", plate_number: "TEST R06 " + (index + 1), seat_capacity: 3, expected_revision: null,
    } });
    check(vehicle.approval_status === "pending", "vehicle_requires_actual_admin_review");
    const denied = await api(origin, "/driver/routes", { token: driver.token, status: 403 });
    check(denied.error.code === "DRIVER_APPROVAL_REQUIRED", "unapproved_driver_cannot_access_routes");
    await api(origin, `/admin/drivers/${driver.id}/approval`, { token: admin.token, method: "PATCH", body: {
      status: "approved", expected_vehicle_revision: vehicle.driver_vehicle.revision,
    } });
    const approved = await api(origin, "/driver/vehicle", { token: driver.token });
    check(approved.approval_status === "approved", "approved_vehicle_persisted");
    driver.vehicleRevision = vehicle.driver_vehicle.revision;
    drivers.push(driver);
  }
  check(new Set([admin.id, passenger.id, ...drivers.map(driver => driver.id)]).size === 5, "accounts_do_not_mix");
  await api(origin, "/admin/queue", { token: passenger.token, status: 403 });
  await api(origin, "/admin/queue", { token: drivers[0].token, status: 403 });
  const empty = await api(origin, "/admin/routes", { token: admin.token, method: "POST", status: 201,
    body: { route_id: "r06-" + randomUUID(), name: "SYNTHETIC R06 A/C/B - NOT A REAL TARIFF", currency: "UZS", price_per_stop: price, active: true } });
  const configured = await api(origin, `/admin/routes/${empty.route.id}/layout`, { token: admin.token, method: "PUT", body: {
    expected_updated_at: empty.route.updatedAt,
    stops: [
      { code: "A", name: "SYNTHETIC R06 A", location: { lat: 41.3111, lng: 69.2797 } },
      { code: "C", name: "SYNTHETIC R06 C", location: { lat: 41.3121, lng: 69.2807 } },
      { code: "B", name: "SYNTHETIC R06 B", location: { lat: 41.3131, lng: 69.2817 } },
    ], pitaks: { aStopCode: "A", bStopCode: "B", radiusMeters: 175 },
  } });
  const route = configured.route;
  check(route.currency === "UZS" && route.pricePerStop === price, "no_currency_relabelling_or_default_price");
  for (const [index, driver] of drivers.entries()) {
    await api(origin, "/driver/route", { token: driver.token, method: "PUT", body: selection(route, index === 2) });
  }
  const none = await api(origin, "/orders/route", { token: passenger.token, method: "POST", body: requestBody(route), status: 409 });
  check(none.error.code === "NO_DRIVERS", "no_phantom_booking_without_driver");
  check((await api(origin, "/orders", { token: passenger.token })).orders.length === 0, "no_durable_order_when_unavailable");
  return { price, admin, passenger, drivers, route };
}

export async function exerciseFixture(initialOrigin, fixture, restart) {
  const { route, drivers, passenger, price } = fixture;
  let origin = initialOrigin;
  const startedAt = [], enrollmentReceipts = new Map();
  // The opposite lane enrolls first. Actual server enrollment receipts, not
  // rewritten timestamps, must still select the first eligible A-lane driver.
  for (const index of [2, 0, 1]) {
    const driver = drivers[index];
    const previous = startedAt.at(-1);
    if (previous !== undefined) {
      const deadline = Date.now() + 1000;
      while (Date.now() <= previous && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 1));
      check(Date.now() > previous, "observable_real_enrollment_order");
    }
    const joined = await api(origin, "/queue/line", { token: driver.token, method: "POST", status: 201,
      body: { route_choice: selection(route, index === 2), location: point(route, index === 2 ? "B" : "A"), available_seats: 3 } });
    startedAt.push(joined.entry.joinedAt);
    enrollmentReceipts.set(driver.id, { joinedAt: joined.entry.joinedAt, enrollmentId: joined.entry.collectionState.enrollmentId, position: joined.position });
    check(joined.entry.collectionState.phase === "collecting", "real_line_enrollment");
  }
  const key = (await api(origin, "/orders/route/request-key", { token: passenger.token })).request_key;
  const posted = await api(origin, "/orders/route", { token: passenger.token, method: "POST", status: 201, key, body: requestBody(route) });
  const order = posted.order;
  fare(order.fare, price);
  check(order.offered_driver_id === drivers[0].id, "eligible_lane_fifo_not_older_opposite_lane");
  check((await ownQueue(origin, drivers[0])).availableSeats === 1, "offer_reserves_two_seats");
  check((await ownQueue(origin, drivers[2])).availableSeats === 3, "opposite_lane_untouched");
  const replay = await api(origin, "/orders/route", { token: passenger.token, method: "POST", key, body: requestBody(route) });
  check(replay.order.id === order.id && replay.replayed === true, "idempotency_does_not_reserve_again");
  check((await ownQueue(origin, drivers[0])).availableSeats === 1, "idempotent_seats_unchanged");
  const rejected = await api(origin, `/orders/${order.id}/reject`, { token: drivers[0].token, method: "POST" });
  check(rejected.order.offered_driver_id === drivers[1].id && rejected.order.status === "searching", "reject_advances_fifo_without_cancelling");
  await api(origin, `/orders/${order.id}/reject`, { token: drivers[0].token, method: "POST", status: 409 });
  const released = await api(origin, "/queue", { token: drivers[0].token });
  check(released.your_entry.availableSeats === 3, "reject_returns_seats_once");
  const firstEnrollment = enrollmentReceipts.get(drivers[0].id);
  check(released.your_entry.joinedAt === firstEnrollment.joinedAt &&
    released.your_entry.collectionState.enrollmentId === firstEnrollment.enrollmentId &&
    released.your_position === firstEnrollment.position, "reject_keeps_actual_fifo_enrollment");
  check((await ownQueue(origin, drivers[1])).availableSeats === 1, "next_offer_reserves_once");
  const accepted = await api(origin, `/orders/${order.id}/accept`, { token: drivers[1].token, method: "POST" });
  check(accepted.order.status === "en_route_to_c", "actual_acceptance");
  check((await ownQueue(origin, drivers[1])).availableSeats === 1, "accept_does_not_reserve_twice");
  await api(origin, `/orders/${order.id}/accept`, { token: drivers[1].token, method: "POST", status: 409 });
  check((await ownQueue(origin, drivers[1])).availableSeats === 1, "duplicate_accept_keeps_reservation");
  await api(origin, `/orders/${order.id}/status`, { token: drivers[1].token, method: "PATCH", body: { status: "arrived_at_c" } });
  const boarded = await api(origin, `/orders/${order.id}/board`, { token: drivers[1].token, method: "POST", body: {} });
  check(boarded.order.status === "boarded_waiting" && (await ownQueue(origin, drivers[1])).availableSeats === 1, "boarding_keeps_reserved_seats");
  await api(origin, `/orders/${order.id}/board`, { token: drivers[1].token, method: "POST", body: {}, status: 409 });
  check((await ownQueue(origin, drivers[1])).availableSeats === 1, "duplicate_board_keeps_reservation");
  check((await api(origin, "/orders", { token: passenger.token })).orders.length === 1, "one_durable_order_after_idempotent_replay");
  const frozen = structuredClone(order.fare);
  const beforeRestart = await ownQueue(origin, drivers[1]);
  const restarted = await restart(); origin = restarted.origin;
  check(restarted.changed, "new_api_process_started");
  for (const actor of [fixture.admin, passenger, ...drivers]) {
    check((await api(origin, "/auth/me", { token: actor.token })).user.id === actor.id, "sessions_survive_restart");
  }
  const restored = (await api(origin, `/orders/${order.id}`, { token: passenger.token })).order;
  check(restored.status === "boarded_waiting", "boarding_survives_actual_api_restart");
  check(JSON.stringify(restored.fare) === JSON.stringify(frozen), "frozen_fare_survives_restart");
  const resumedQueue = await ownQueue(origin, drivers[1]);
  check(resumedQueue.availableSeats === 1 && resumedQueue.collectionState.enrollmentId === beforeRestart.collectionState.enrollmentId,
    "reservation_and_enrollment_survive_restart");
  const departure = await api(origin, "/queue/depart", { token: drivers[1].token, method: "POST",
    body: { expected_enrollment_id: resumedQueue.collectionState.enrollmentId } });
  check(departure.changed === true && departure.orders.some(value => value.id === order.id && value.status === "in_transit"), "actual_departure_starts_ride");
  const departed = await api(origin, "/queue", { token: drivers[1].token });
  check(departed.your_entry.collectionState.phase === "departed" && departed.your_entry.inFifo === false &&
    departed.your_position === null && departed.your_entry.availableSeats === 1, "departure_leaves_fifo_without_releasing_seats");
  const retryDeparture = await api(origin, "/queue/depart", { token: drivers[1].token, method: "POST",
    body: { expected_enrollment_id: resumedQueue.collectionState.enrollmentId } });
  check(retryDeparture.changed === false && retryDeparture.entry.collectionState.departedAt === departed.your_entry.collectionState.departedAt &&
    retryDeparture.entry.collectionState.enrollmentId === resumedQueue.collectionState.enrollmentId &&
    retryDeparture.entry.availableSeats === 1, "departure_retry_is_idempotent");
  const completed = await api(origin, `/orders/${order.id}/status`, { token: drivers[1].token, method: "PATCH", body: { status: "completed" } });
  check(JSON.stringify(completed.order.fare) === JSON.stringify(frozen), "completion_keeps_frozen_fare");
  await api(origin, `/orders/${order.id}/status`, { token: drivers[1].token, method: "PATCH", body: { status: "completed" }, status: 409 });
  check((await ownQueue(origin, drivers[1])).availableSeats === 3, "completion_returns_seats_exactly_once");
  const history = (await api(origin, "/orders", { token: passenger.token })).orders;
  check(history.length === 1, "exactly_one_completed_durable_order");
  check(history.some(value => value.id === order.id && value.status === "completed" && JSON.stringify(value.fare) === JSON.stringify(frozen)), "durable_completed_history");
  const recovered = await api(origin, "/orders/route/requests/" + key, { token: passenger.token });
  check(recovered.order.id === order.id && recovered.order.status === "completed", "request_recovery_after_restart_and_completion");
  fixture.exercise = { orderId: order.id, requestKey: key, frozenFare: frozen };
  return { actualApiRestart: true, lifecycle: "PASS", fifoRejectReoffer: true, oppositeLaneIsolated: true,
    idempotentBooking: true, onceOnlySeatReturn: true, frozenUzsHistory: true, activeReservationRestored: true };
}

export async function probeFixture(origin, fixture) {
  await api(origin, "/healthz");
  for (const actor of [fixture.admin, fixture.passenger, ...fixture.drivers]) {
    check((await api(origin, "/auth/me", { token: actor.token })).user.id === actor.id, "retained_accounts_and_sessions");
  }
  for (const [index, driver] of fixture.drivers.entries()) {
    const vehicle = await api(origin, "/driver/vehicle", { token: driver.token });
    check(vehicle.approval_status === "approved" && vehicle.driver_vehicle?.revision === driver.vehicleRevision, "retained_approved_vehicle_revision");
    const selected = await api(origin, "/driver/route", { token: driver.token });
    check(selected.choice?.routeId === fixture.route.id && selected.choice?.direction === (index === 2 ? "b_to_a" : "a_to_b"), "retained_route_choice_and_direction");
  }
  const routes = await api(origin, "/orders/routes", { token: fixture.passenger.token });
  const route = routes.routes.find(value => value.id === fixture.route.id);
  check(route?.currency === "UZS" && route.pricePerStop === fixture.price, "retained_explicit_test_tariff");
  const history = (await api(origin, "/orders", { token: fixture.passenger.token })).orders;
  check(!!fixture.exercise, "completed_lifecycle_required_before_retained_state_probe");
  const completed = history.find(order => order.id === fixture.exercise.orderId && order.status === "completed");
  check(history.length === 1 && !!completed, "retained_exact_completed_order");
  fare(completed.fare, fixture.price);
  check(JSON.stringify(completed.fare) === JSON.stringify(fixture.exercise.frozenFare), "retained_exact_frozen_fare");
  const recovered = await api(origin, "/orders/route/requests/" + fixture.exercise.requestKey, { token: fixture.passenger.token });
  check(recovered.order.id === fixture.exercise.orderId, "retained_exact_booking_key");
  for (const driver of fixture.drivers) check((await ownQueue(origin, driver)).availableSeats === 3, "retained_seats_after_reconnect");
  return { retainedAccounts: true, retainedApprovedVehicles: true, retainedCompletedHistory: true, retainedSeats: true };
}
