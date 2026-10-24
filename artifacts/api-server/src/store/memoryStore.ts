import { assertVehicleQueueCapacity, assertVehicleReview, createDriverVehicle, hasRequiredDriverApproval } from "../utils/driverVehicle";
import { randomUUID } from "node:crypto";
import { OFFER_TIMEOUT_MS, OTP_TTL_MS, REQUIRE_DRIVER_APPROVAL, SEAT_LOCK_TTL_MS } from "../utils/config";
import { normalizePhone } from "../utils/phone";
import type { DriverRouteChoiceInput, ExternalPickupSelectionInput, OtpLimitResult, OtpVerifyResult, RouteLayoutInput, RouteOrderAvailability, RouteOrderInput, RouteOrderSelectionInput, Store } from "./storeContract";
import { emptyOtpRateState, OTP_CLEANUP_BATCH_SIZE, otpFailureState, otpPhoneBlock, otpRateExpiresAt, otpRateKey, recordOtpFailure, takeOtpIp, takeOtpSend } from "./otpProtection";
import type { OtpRateKind, OtpRateState } from "./otpProtection";
import { mutateRouteStop, nextRouteUpdatedAt, replaceRouteLayout } from "../utils/routeLayout";
import { assertDriverRouteChoiceRoute, validateDriverRouteChoiceInput } from "../utils/driverRoute";
import { canTransitionOrder, claimQueueEntry, hasActiveOrders, joinQueueEntry, releaseQueueEntry, transitionQueueEntry } from "./orderLifecycle";
import { AppError } from "../utils/errors";
import { assertRouteQueueLocation, assertRouteQueueTelemetry, resolveRouteQueue, routeQueueSnapshot, sameQueueLane } from "../utils/routeQueue";
import { acceptQueueOffer, assertLegacyOrderInput, assertOrderOfferPatch, assertQueueOfferPatch, compareOfferDrivers, hasLiveOrderOffer, orderedOfferCandidates, releaseQueueOffer, reserveQueueOffer } from "./orderOffers";
import { buildRouteOrder, validateRouteOrderSelectionInput } from "../utils/routeOrder";
import { assertRouteOrderRequestHash, requireRouteOrderRequestKey, routeOrderRequestHash } from "../utils/routeOrderRequest";
import { boundedInteger } from "../utils/validation";
import { assertLineOrderTransition, createLineCollectionState, isCollecting, lineOrderIds, prepareLineDeparture } from "./lineCollection";
import { assertExternalQuoteCurrent, buildConfirmedExternalOrder, buildExternalPickupDetails, eligibleExternalCandidate, externalPickupLeaseMs, liveExternalOfferValid, nextOrderUpdatedAt, normalizeExternalPickupSettings, repriceExternalOrder, validateExternalPickupSelectionInput } from "./externalPickup";
import type {
  Coordinates,
  DeviceRegistration,
  DriverQueueStatus,
  DriverApprovalStatus,
  DriverVehicleInput,
  DriverRouteChoice,
  ExternalPickupQuote,
  ExternalPickupSettings,
  Locale,
  Order,
  OrderOfferChange,
  OrderStatus,
  OtpChallenge,
  PickupPoint,
  RouteDefinition,
  RouteStop,
  QueueEntry,
  User,
  UserRole,
} from "../types/domain";

class MemoryStore implements Store {
  private readonly users = new Map<string, User>();
  private readonly usersByPhone = new Map<string, string>();
  private readonly otpChallenges = new Map<string, OtpChallenge>();
  private readonly otpRateLimits = new Map<string, { state: OtpRateState; expiresAt: number }>();
  private otpRateCleanupIterator?: IterableIterator<[string, { state: OtpRateState; expiresAt: number }]>;
  private otpChallengeCleanupIterator?: IterableIterator<[string, OtpChallenge]>;
  private readonly queueEntries = new Map<string, QueueEntry>();
  private readonly orders = new Map<string, Order>();
  private readonly routeOrderRequests = new Map<string, { requestHash: string; orderId: string }>();
  private readonly deviceRegistrations = new Map<string, DeviceRegistration>();
  private readonly routes = new Map<string, RouteDefinition>();

  initialize(): void {}

  constructor() {
    const now = new Date().toISOString();
    this.routes.set("pyatak", {
      id: "pyatak",
      name: "Pyatak",
      currency: "KZT",
      pricePerStopKzt: 500,
      active: true,
      stops: [
        { id: "pyatak-stop-c", code: "C", name: "Point C", sequence: 1, position: 1 },
        { id: "pyatak-stop-d", code: "D", name: "Point D", sequence: 2, position: 2 },
      ],
      createdAt: now,
      updatedAt: now,
    });
  }

  createUser(input: {
    role: UserRole;
    fullName: string;
    phoneNumber: string;
    locale: Locale;
  }): User {
    const user: User = {
      id: randomUUID(),
      role: input.role,
      roles: [input.role],
      fullName: input.fullName,
      phoneNumber: input.phoneNumber,
      locale: input.locale,
      profileLocked: true,
      sessionVersion: 0,
      driverApprovalStatus:
        input.role === "driver" && REQUIRE_DRIVER_APPROVAL
          ? "pending"
          : input.role === "driver"
            ? "approved"
            : undefined,
      createdAt: new Date().toISOString(),
    };
    this.users.set(user.id, user);
    this.usersByPhone.set(user.phoneNumber, user.id);
    return structuredClone(user);
  }

  getUser(userId: string): User | undefined {
    const user = this.users.get(userId);
    return user ? structuredClone(user) : undefined;
  }

  getUserByPhone(phoneNumber: string): User | undefined {
    const userId = this.usersByPhone.get(phoneNumber);
    return userId ? this.getUser(userId) : undefined;
  }

  updateUser(userId: string, patch: Partial<Pick<User, "locale" | "lastLocation">>): User {
    const user = this.users.get(userId);
    if (!user) {
      throw new Error(`User ${userId} not found`);
    }
    Object.assign(user, patch);
    return structuredClone(user);
  }

  invalidateSessions(userId: string): User {
    const user = this.users.get(userId);
    if (!user) {
      throw new Error(`User ${userId} not found`);
    }
    user.sessionVersion += 1;
    return structuredClone(user);
  }

  saveOtp(challenge: OtpChallenge): void {
    this.cleanupOtp(Date.now());
    this.otpChallenges.set(challenge.phoneNumber, structuredClone(challenge));
  }

  private cleanupOtp(now: number): void {
    this.otpRateCleanupIterator ??= this.otpRateLimits.entries();
    for (let scanned = 0; scanned < OTP_CLEANUP_BATCH_SIZE; scanned += 1) {
      const item = this.otpRateCleanupIterator.next();
      if (item.done) {
        this.otpRateCleanupIterator = undefined;
        break;
      }
      const [key, row] = item.value;
      if (row.expiresAt <= now && row.state.blockedUntil <= now) this.otpRateLimits.delete(key);
    }
    this.otpChallengeCleanupIterator ??= this.otpChallenges.entries();
    for (let scanned = 0; scanned < OTP_CLEANUP_BATCH_SIZE; scanned += 1) {
      const item = this.otpChallengeCleanupIterator.next();
      if (item.done) {
        this.otpChallengeCleanupIterator = undefined;
        break;
      }
      if (item.value[1].expiresAt <= now) this.otpChallenges.delete(item.value[0]);
    }
  }

  private otpState(key: string): OtpRateState {
    return { ...(this.otpRateLimits.get(key)?.state ?? emptyOtpRateState()) };
  }

  private saveOtpState(kind: OtpRateKind, key: string, state: OtpRateState): void {
    this.otpRateLimits.set(key, { state: { ...state }, expiresAt: otpRateExpiresAt(kind, state) });
  }

  takeOtpIpBudget(clientKey: string): OtpLimitResult {
    const now = Date.now();
    this.cleanupOtp(now);
    const key = otpRateKey("ip", clientKey);
    const budget = takeOtpIp(this.otpState(key), now);
    this.saveOtpState("ip", key, budget.state);
    return budget.result;
  }

  saveOtpProtected(challenge: OtpChallenge): OtpLimitResult {
    const now = Date.now();
    this.cleanupOtp(now);
    const phoneNumber = normalizePhone(challenge.phoneNumber);
    const sendKey = otpRateKey("send", phoneNumber);
    const verifyKey = otpRateKey("verify", phoneNumber);
    const verification = otpFailureState(this.otpState(verifyKey), now);
    this.saveOtpState("verify", verifyKey, verification);
    const block = otpPhoneBlock(verification, now);
    if (!block.allowed) return block;
    const budget = takeOtpSend(this.otpState(sendKey), now);
    this.saveOtpState("send", sendKey, budget.state);
    if (budget.result.allowed) {
      this.otpChallenges.set(phoneNumber, structuredClone({
        ...challenge, phoneNumber, expiresAt: now + OTP_TTL_MS,
      }));
    }
    return budget.result;
  }

  consumeOtpProtected(phone: string, code: string): OtpVerifyResult {
    const now = Date.now();
    this.cleanupOtp(now);
    const phoneNumber = normalizePhone(phone);
    const verifyKey = otpRateKey("verify", phoneNumber);
    const verification = otpFailureState(this.otpState(verifyKey), now);
    const block = otpPhoneBlock(verification, now);
    if (!block.allowed) return { status: "limited", retryAfterMs: block.retryAfterMs };
    const challenge = this.otpChallenges.get(phoneNumber);
    if (challenge && challenge.code === code && challenge.expiresAt > now) {
      this.otpChallenges.delete(phoneNumber);
      this.saveOtpState("verify", verifyKey, { ...emptyOtpRateState(), windowStartedAt: now });
      return { status: "verified", challenge: structuredClone(challenge) };
    }
    const failure = recordOtpFailure(verification, now);
    this.saveOtpState("verify", verifyKey, failure);
    const limit = otpPhoneBlock(failure, now);
    return limit.allowed ? { status: "invalid" } : { status: "limited", retryAfterMs: limit.retryAfterMs };
  }

  activateUserRole(userId: string, nextRole: "passenger" | "driver", expectedSessionVersion?: number): User {
    if (nextRole !== "passenger" && nextRole !== "driver") {
      throw new AppError(400, "Only passenger and driver modes are available", "INVALID_ROLE");
    }
    const user = this.users.get(userId);
    if (!user) throw new AppError(401, "Account is not available", "UNAUTHORIZED");
    if (expectedSessionVersion !== undefined && user.sessionVersion !== expectedSessionVersion) {
      throw new AppError(401, "Session is no longer valid", "UNAUTHORIZED");
    }
    if (user.role === "admin" || user.roles.includes("admin")) {
      throw new AppError(403, "Admin accounts cannot switch modes", "ADMIN_ROLE_FORBIDDEN");
    }
    if (this.queueEntries.has(userId) || [...this.orders.values()].some(order =>
      order.status !== "completed" && order.status !== "cancelled" &&
      (order.passengerId === userId || order.driverId === userId || order.offeredDriverId === userId),
    )) {
      throw new AppError(409, "Finish active orders and leave the driver queue before switching modes", "ROLE_BUSY");
    }
    if (!user.roles.includes(nextRole)) {
      user.roles.push(nextRole);
      if (nextRole === "driver") user.driverApprovalStatus = "pending";
    }
    user.role = nextRole;
    user.sessionVersion += 1;
    return structuredClone(user);
  }

  private requireCurrentRole(userId: string, role: "passenger" | "driver", expectedSessionVersion?: number): void {
    const user = this.users.get(userId);
    if (!user || (expectedSessionVersion !== undefined && user.sessionVersion !== expectedSessionVersion)) {
      throw new AppError(401, "Session is no longer valid", "UNAUTHORIZED");
    }
    if (user.role !== role) throw new AppError(403, `${role} mode is required`, "FORBIDDEN");
  }

  setDriverVehicle(userId: string, input: DriverVehicleInput, expectedSessionVersion: number): User {
    this.requireCurrentRole(userId, "driver", expectedSessionVersion);
    const user = this.users.get(userId)!;
    if (this.queueEntries.has(userId) || [...this.orders.values()].some(order =>
      order.status !== "completed" && order.status !== "cancelled" &&
      (order.passengerId === userId || order.driverId === userId || order.offeredDriverId === userId))) {
      throw new AppError(409, "Finish active orders and leave the queue before changing the vehicle", "DRIVER_VEHICLE_BUSY");
    }
    user.driverVehicle = createDriverVehicle(input, user.driverVehicle);
    user.driverApprovalStatus = "pending";
    return structuredClone(user);
  }

  setDriverRouteChoice(userId: string, input: DriverRouteChoiceInput | null, expectedSessionVersion: number): DriverRouteChoice | null {
    const value = input === null ? null : validateDriverRouteChoiceInput(input);
    if (this.users.get(userId)?.sessionVersion !== expectedSessionVersion) {
      throw new AppError(401, "Session is no longer valid", "UNAUTHORIZED");
    }
    this.requireCurrentRole(userId, "driver", expectedSessionVersion);
    const user = this.users.get(userId)!;
    if (!hasRequiredDriverApproval(user, REQUIRE_DRIVER_APPROVAL)) {
      throw new AppError(403, "Driver approval is required", "DRIVER_APPROVAL_REQUIRED");
    }
    if (this.queueEntries.has(userId) || [...this.orders.values()].some(order =>
      order.status !== "completed" && order.status !== "cancelled" &&
      (order.passengerId === userId || order.driverId === userId || order.offeredDriverId === userId),
    )) {
      throw new AppError(409, "Finish active orders and leave the queue before changing the planned route", "DRIVER_ROUTE_BUSY");
    }
    if (value === null) {
      delete user.driverRouteChoice;
      return null;
    }
    const route = this.routes.get(value.routeId);
    assertDriverRouteChoiceRoute(route, value.expectedUpdatedAt);
    const choice: DriverRouteChoice = {
      routeId: route.id,
      direction: value.direction,
      routeUpdatedAt: route.updatedAt,
    };
    user.driverRouteChoice = structuredClone(choice);
    return structuredClone(choice);
  }

  consumeOtp(phoneNumber: string, code: string): OtpChallenge | undefined {
    this.cleanupOtp(Date.now());
    const challenge = this.otpChallenges.get(phoneNumber);
    if (!challenge || challenge.code !== code || challenge.expiresAt <= Date.now()) {
      return undefined;
    }
    this.otpChallenges.delete(phoneNumber);
    return structuredClone(challenge);
  }

  getQueueEntry(driverId: string): QueueEntry | undefined {
    const entry = this.queueEntries.get(driverId);
    return entry?.routeContext ? structuredClone(entry) : entry;
  }

  /**
   * Redis equivalent: remove the driver from the FIFO sorted set while
   * retaining the active-trip record for pooled orders.
   */
  removeDriverFromFifo(driverId: string): QueueEntry | undefined {
    return this.updateQueueEntry(driverId, { inFifo: false });
  }

  returnDriverToFifo(driverId: string): QueueEntry | undefined {
    return this.updateQueueEntry(driverId, { inFifo: true });
  }

  joinQueue(entry: QueueEntry, expectedSessionVersion?: number, selection?: DriverRouteChoiceInput, collectionMode = false): QueueEntry {
    this.requireCurrentRole(entry.driverId, "driver", expectedSessionVersion);
    if (entry.routeContext || entry.collectionState !== undefined) throw new AppError(400, "Queue context is server-owned", "VALIDATION_ERROR");
    const user = this.users.get(entry.driverId)!;
    assertVehicleQueueCapacity(user, entry.availableSeats);
    if (user.driverRouteChoice && !hasRequiredDriverApproval(user, REQUIRE_DRIVER_APPROVAL)) {
      throw new AppError(403, "Driver approval is required", "DRIVER_NOT_APPROVED");
    }
    const current = this.queueEntries.get(entry.driverId);
    if (current && Boolean(current.collectionState) !== collectionMode) {
      throw new AppError(409, "Leave the current queue before changing its mode", "QUEUE_BUSY");
    }
    if (current?.collectionState && entry.availableSeats !== current.collectionState.capacity) {
      throw new AppError(409, "Leave the current line before changing vehicle capacity", "QUEUE_BUSY");
    }
    if (current && (hasActiveOrders(current) || current.pendingOfferOrderId || current.inFifo === false)) {
      throw new AppError(409, "Driver cannot rejoin while an order or route is active", "QUEUE_BUSY");
    }
    const routeContext = resolveRouteQueue(user.driverRouteChoice,
      user.driverRouteChoice ? this.routes.get(user.driverRouteChoice.routeId) : undefined, selection, entry.lastLocation);
    if (collectionMode && !routeContext) {
      throw new AppError(409, "A configured route choice is required to join the line", "ROUTE_QUEUE_NOT_AVAILABLE");
    }
    if (collectionMode && routeContext) {
      if (!entry.lastLocation) throw new AppError(422, "Valid location is required", "INVALID_COORDINATES");
      assertRouteQueueLocation(routeContext, entry.lastLocation);
    }
    if (current && (!sameQueueLane(current.routeContext, routeContext) || current.routeContext?.routeUpdatedAt !== routeContext?.routeUpdatedAt)) {
      throw new AppError(409, "Leave the previous queue before joining another", "QUEUE_BUSY");
    }
    const joined = joinQueueEntry({ ...entry, pendingOfferOrderId: undefined, routeContext }, current);
    if (current?.routeContext) joined.availableSeats = current.availableSeats;
    if (collectionMode) {
      const now = Date.now();
      joined.collectionState = current?.collectionState
        ? { ...current.collectionState, locationUpdatedAt: now }
        : createLineCollectionState(boundedInteger(entry.availableSeats, "availableSeats", 1, 8), now);
    }
    this.queueEntries.set(entry.driverId, joined);
    return joined.routeContext ? structuredClone(joined) : joined;
  }

  updateQueueEntry(
    driverId: string,
    patch: Partial<QueueEntry>,
  ): QueueEntry | undefined {
    const entry = this.queueEntries.get(driverId);
    if (!entry) {
      return undefined;
    }
    assertQueueOfferPatch(entry, patch);
    if ("routeContext" in patch) throw new AppError(409, "Queue context cannot be changed", "QUEUE_BUSY");
    if (entry.routeContext && patch.lastLocation) assertRouteQueueTelemetry(entry, patch.lastLocation);
    Object.assign(entry, patch);
    if (entry.collectionState && patch.lastLocation) {
      entry.collectionState = { ...entry.collectionState, locationUpdatedAt: Date.now() };
    }
    return entry.routeContext ? structuredClone(entry) : entry;
  }

  leaveQueue(driverId: string): void {
    const current = this.queueEntries.get(driverId);
    if (current && (hasActiveOrders(current) || current.pendingOfferOrderId)) {
      throw new AppError(409, "Driver cannot leave the queue while an order is active", "ACTIVE_ORDER");
    }
    this.queueEntries.delete(driverId);
  }

  departQueue(driverId: string, expectedEnrollmentId: string, expectedSessionVersion?: number): { entry: QueueEntry; orders: Order[]; changed: boolean } {
    this.requireCurrentRole(driverId, "driver", expectedSessionVersion);
    if (!hasRequiredDriverApproval(this.users.get(driverId), REQUIRE_DRIVER_APPROVAL)) {
      throw new AppError(403, "Driver approval is required", "DRIVER_NOT_APPROVED");
    }
    const entry = this.queueEntries.get(driverId);
    if (!entry) throw new AppError(404, "Driver is not in the queue", "NOT_IN_QUEUE");
    const orders = lineOrderIds(entry).flatMap(id => {
      const order = this.orders.get(id);
      return order ? [order] : [];
    });
    // No await occurs between the live manifest read and publishing these values.
    const result = prepareLineDeparture(entry, orders, expectedEnrollmentId);
    if (result.changed) {
      this.queueEntries.set(driverId, result.entry);
      for (const order of result.orders) this.orders.set(order.id, order);
    }
    return structuredClone(result);
  }

  getQueue(): QueueEntry[] {
    return [...this.queueEntries.values()]
      .filter((entry) => entry.inFifo !== false)
      .filter((entry) => isCollecting(entry) || !entry.seatLockExpiresAt || entry.seatLockExpiresAt > Date.now())
      .sort(compareOfferDrivers)
      .map(entry => entry.routeContext ? structuredClone(entry) : entry);
  }

  getQueuePosition(driverId: string): number | null {
    return this.queueSnapshot().find(entry => entry.driverId === driverId)?.position ?? null;
  }

  getFirstEligibleDriver(seats: number): QueueEntry | undefined {
    return [...this.queueEntries.values()].sort(compareOfferDrivers).find(
      (entry) =>
        !entry.routeContext &&
        entry.status === "in_transit" &&
        !entry.pendingOfferOrderId &&
        entry.availableSeats >= seats &&
        Boolean(
          entry.currentOrderId ||
            (entry.activeOrderIds && entry.activeOrderIds.length > 0),
        ),
    );
  }

  private eligibleOfferEntries(): QueueEntry[] {
    return [...this.queueEntries.values()].filter(entry =>
      this.users.get(entry.driverId)?.role === "driver" &&
      hasRequiredDriverApproval(this.users.get(entry.driverId), REQUIRE_DRIVER_APPROVAL),
    );
  }

  getOrderAvailability(pickupPoint: PickupPoint, seats: number): { available: boolean; eligibleDriverCount: number } {
    assertLegacyOrderInput({ pickupPoint });
    const eligibleDriverCount = orderedOfferCandidates({ pickupPoint, seats }, this.eligibleOfferEntries(), Date.now()).length;
    return { available: eligibleDriverCount > 0, eligibleDriverCount };
  }

  getRouteOrderAvailability(selection: RouteOrderSelectionInput, seats: number): RouteOrderAvailability {
    selection = validateRouteOrderSelectionInput(selection);
    seats = boundedInteger(seats, "seats", 1, 8);
    const route = this.routes.get(selection.routeId);
    const routeOrder = buildRouteOrder(route, selection);
    const eligibleDriverCount = orderedOfferCandidates(
      { ...routeOrder, seats }, this.eligibleOfferEntries(), Date.now(), route,
    ).length;
    return { available: eligibleDriverCount > 0, eligibleDriverCount, fare: routeOrder.fare };
  }

  getExternalPickupCandidates(selection: ExternalPickupSelectionInput, seats: number, excludedDriverIds: string[] = []): { route: RouteDefinition; candidates: QueueEntry[] } {
    selection = validateExternalPickupSelectionInput(selection);
    seats = boundedInteger(seats, "seats", 1, 8);
    const route = this.routes.get(selection.routeId);
    // Validate the configured route, pickup policy, and destination before exposing candidates.
    buildExternalPickupDetails(route, selection);
    const now = Date.now();
    const candidates = this.eligibleOfferEntries().filter(entry =>
      eligibleExternalCandidate(entry, route!, selection, seats, excludedDriverIds, now),
    );
    return structuredClone({ route: route!, candidates });
  }

  updateExternalPickupSettings(routeId: string, input: { expectedUpdatedAt: string; settings: ExternalPickupSettings }): RouteDefinition | undefined {
    const route = this.routes.get(routeId);
    if (!route) return undefined;
    if (route.updatedAt !== input.expectedUpdatedAt) {
      throw new AppError(409, "Route changed; reload the catalog", "ROUTE_CHANGED");
    }
    const settings = normalizeExternalPickupSettings(input.settings);
    const updated = { ...route, externalPickup: settings, updatedAt: nextRouteUpdatedAt(route.updatedAt) };
    this.routes.set(routeId, updated);
    return structuredClone(updated);
  }

  confirmExternalPickupQuote(quote: ExternalPickupQuote, passengerId: string, expectedSessionVersion: number): { order: Order; created: boolean; changed: boolean } {
    if (quote.passengerId !== passengerId) {
      throw new AppError(403, "Quote belongs to another passenger", "FORBIDDEN");
    }
    this.requireCurrentRole(passengerId, "passenger", expectedSessionVersion);
    const orderId = quote.orderId ?? quote.quoteId;
    const existing = this.orders.get(orderId);
    if (existing && existing.passengerId !== passengerId) {
      throw new AppError(403, "Order belongs to another passenger", "FORBIDDEN");
    }
    // The original UUID is a permanent idempotency key, including after a
    // later repricing. Replaying it can never reserve another driver's seats.
    if (existing && (!quote.orderId || existing.externalPickup?.quoteId === quote.quoteId)) {
      return { order: structuredClone(existing), created: false, changed: false };
    }
    if (quote.orderId && !existing) {
      throw new AppError(404, "Order not found", "ORDER_NOT_FOUND");
    }
    const passenger = this.users.get(passengerId)!;
    const driver = this.users.get(quote.driverId);
    if (!driver || driver.role !== "driver" || !hasRequiredDriverApproval(driver, REQUIRE_DRIVER_APPROVAL)) {
      throw new AppError(409, "Selected driver is no longer available", "QUOTE_CHANGED");
    }
    const entry = this.queueEntries.get(quote.driverId);
    const route = this.routes.get(quote.selection.routeId);
    const now = Date.now();
    assertExternalQuoteCurrent(quote, route, entry, passengerId, expectedSessionVersion, now);
    if (!route || !entry) {
      throw new AppError(409, "Selected driver is no longer available", "QUOTE_CHANGED");
    }
    const order = buildConfirmedExternalOrder(quote, route, {
      id: passenger.id, phoneNumber: passenger.phoneNumber,
    }, existing, now);
    // No await occurs between validation and publishing either value. Build
    // both first so failed validation cannot leave a partial reservation.
    const reserved = reserveQueueOffer(entry, order);
    this.queueEntries.set(entry.driverId, reserved);
    this.orders.set(order.id, order);
    return { order: structuredClone(order), created: !existing, changed: true };
  }

  createOrder(input: Omit<Order, "id" | "createdAt" | "updatedAt">, expectedSessionVersion?: number): Order {
    assertLegacyOrderInput(input);
    this.requireCurrentRole(input.passengerId, "passenger", expectedSessionVersion);
    const now = new Date().toISOString();
    const order: Order = {
      ...input,
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
    };
    this.orders.set(order.id, order);
    return order;
  }

  createOrderWithOffer(input: Omit<Order, "id" | "createdAt" | "updatedAt">, expectedSessionVersion?: number): Order | undefined {
    assertLegacyOrderInput(input);
    return this.reserveNewOrder(input, expectedSessionVersion);
  }

  createRouteOrderWithOffer(input: RouteOrderInput, selection: RouteOrderSelectionInput, expectedSessionVersion?: number): Order | undefined {
    selection = validateRouteOrderSelectionInput(selection);
    if (!input.pickupLocation) throw new AppError(422, "Pickup location is required", "OUTSIDE_PICKUP_GEOFENCE");
    const route = this.routes.get(selection.routeId);
    const details = buildRouteOrder(route, selection, input.pickupLocation);
    return this.reserveNewOrder({
      passengerId: input.passengerId, passengerPhone: input.passengerPhone,
      pickupLocation: input.pickupLocation, seats: boundedInteger(input.seats, "seats", 1, 8),
      ...details, status: "searching",
    }, expectedSessionVersion, route);
  }

  getRouteOrderRequest(passengerId: string, requestKey: string, expectedSessionVersion?: number) {
    const key = requireRouteOrderRequestKey(requestKey);
    this.requireCurrentRole(passengerId, "passenger", expectedSessionVersion);
    const receipt = this.routeOrderRequests.get(JSON.stringify([passengerId, key]));
    if (!receipt) return undefined;
    const order = this.orders.get(receipt.orderId);
    if (!order || order.passengerId !== passengerId) {
      throw new AppError(409, "Booking requires recovery; do not create another request", "ORDER_RECOVERY_REQUIRED");
    }
    return { order: structuredClone(order), requestHash: receipt.requestHash };
  }

  createRouteOrderOnce(input: RouteOrderInput, selection: RouteOrderSelectionInput, requestKey: string, expectedSessionVersion?: number) {
    const key = requireRouteOrderRequestKey(requestKey);
    const requestHash = routeOrderRequestHash(selection, input.seats);
    const receipt = this.getRouteOrderRequest(input.passengerId, key, expectedSessionVersion);
    if (receipt) {
      assertRouteOrderRequestHash(receipt.requestHash, requestHash);
      return { order: receipt.order, created: false };
    }
    // The memory adapter is synchronous; no other allocator can interleave here.
    const order = this.createRouteOrderWithOffer(input, selection, expectedSessionVersion);
    if (!order) return undefined;
    this.routeOrderRequests.set(JSON.stringify([input.passengerId, key]), { requestHash, orderId: order.id });
    return { order, created: true };
  }

  private reserveNewOrder(input: Omit<Order, "id" | "createdAt" | "updatedAt">, expectedSessionVersion?: number, liveRoute?: RouteDefinition): Order | undefined {
    this.requireCurrentRole(input.passengerId, "passenger", expectedSessionVersion);
    const now = Date.now();
    const next = orderedOfferCandidates(
      { ...input, attemptedDriverIds: [] }, this.eligibleOfferEntries(), now, liveRoute,
    )[0];
    if (!next) return undefined;
    const timestamp = new Date(now).toISOString();
    const order: Order = {
      ...(input.routeContext ? structuredClone(input) : input),
      id: randomUUID(),
      createdAt: timestamp,
      updatedAt: timestamp,
      status: "searching",
      driverId: undefined,
      offeredDriverId: next.driverId,
      offerExpiresAt: now + OFFER_TIMEOUT_MS,
      attemptedDriverIds: [next.driverId],
      seatLockExpiresAt: undefined,
    };
    this.queueEntries.set(next.driverId, reserveQueueOffer(next, order));
    this.orders.set(order.id, order);
    return order.routeContext ? structuredClone(order) : order;
  }

  getOrder(orderId: string): Order | undefined {
    const order = this.orders.get(orderId);
    return order?.routeContext ? structuredClone(order) : order;
  }

  updateOrder(orderId: string, patch: Partial<Order>): Order | undefined {
    const order = this.orders.get(orderId);
    if (!order) {
      return undefined;
    }
    assertOrderOfferPatch(order, patch);
    const updated = this.writeOrder(order, patch);
    return updated.routeContext ? structuredClone(updated) : updated;
  }

  private writeOrder(order: Order, patch: Partial<Order>, now = Date.now()): Order {
    Object.assign(order, patch, { id: order.id, updatedAt: nextOrderUpdatedAt(order.updatedAt, now) });
    return order;
  }

  private isValidReservedOffer(order: Order, now: number): boolean {
    const entry = order.offeredDriverId ? this.queueEntries.get(order.offeredDriverId) : undefined;
    if (!entry || entry.pendingOfferOrderId !== order.id || entry.availableSeats < 0) return false;
    if (this.users.get(entry.driverId)?.role !== "driver") return false;
    if (!hasRequiredDriverApproval(this.users.get(entry.driverId), REQUIRE_DRIVER_APPROVAL)) return false;
    if (order.externalPickup) {
      return liveExternalOfferValid(order, entry,
        order.routeContext ? this.routes.get(order.routeContext.routeId) : undefined, now);
    }
    return orderedOfferCandidates(
      { ...order, attemptedDriverIds: [] },
      [{ ...entry, pendingOfferOrderId: undefined, availableSeats: entry.availableSeats + order.seats }],
      now,
      order.routeContext ? this.routes.get(order.routeContext.routeId) : undefined,
    ).length > 0;
  }

  private advanceOrderOffer(order: Order, now: number, previousDriverId?: string): OrderOfferChange | undefined {
    const previousEntry = previousDriverId ? this.queueEntries.get(previousDriverId) : undefined;
    if (previousEntry) {
      this.queueEntries.set(previousEntry.driverId, releaseQueueOffer(previousEntry, order));
    }
    if (order.externalPickup) {
      if (!previousDriverId && order.externalPickup.requiresPriceConfirmation) return undefined;
      const repriced = repriceExternalOrder(order, now);
      this.orders.set(order.id, repriced);
      return { order: structuredClone(repriced), ...(previousDriverId ? { previousDriverId } : {}) };
    }
    const attemptedDriverIds = [...new Set([
      ...(order.attemptedDriverIds ?? []),
      ...(previousDriverId ? [previousDriverId] : []),
    ])];
    const next = orderedOfferCandidates({ ...order, attemptedDriverIds }, this.eligibleOfferEntries(), now,
      order.routeContext ? this.routes.get(order.routeContext.routeId) : undefined)[0];
    if (!next && !previousDriverId) return undefined;
    if (next) {
      this.queueEntries.set(next.driverId, reserveQueueOffer(next, order));
      attemptedDriverIds.push(next.driverId);
    }
    this.writeOrder(order, {
      offeredDriverId: next?.driverId,
      offerExpiresAt: next ? now + OFFER_TIMEOUT_MS : undefined,
      attemptedDriverIds,
    }, now);
    return { order: order.routeContext ? structuredClone(order) : { ...order }, ...(previousDriverId ? { previousDriverId } : {}) };
  }

  dispatchOrderOffer(orderId: string, now = Date.now()): OrderOfferChange | undefined {
    const order = this.orders.get(orderId);
    if (!order || order.status !== "searching" || order.driverId) return undefined;
    if (hasLiveOrderOffer(order, now) && this.isValidReservedOffer(order, now)) return undefined;
    return this.advanceOrderOffer(order, now, order.offeredDriverId);
  }

  rejectOrderOffer(orderId: string, driverId: string, now = Date.now(), expectedSessionVersion?: number): OrderOfferChange | undefined {
    if (expectedSessionVersion !== undefined) {
      this.requireCurrentRole(driverId, "driver", expectedSessionVersion);
      if (!hasRequiredDriverApproval(this.users.get(driverId), REQUIRE_DRIVER_APPROVAL)) return undefined;
    }
    const order = this.orders.get(orderId);
    if (!order || order.offeredDriverId !== driverId || !hasLiveOrderOffer(order, now) ||
      this.queueEntries.get(driverId)?.pendingOfferOrderId !== order.id) return undefined;
    return this.advanceOrderOffer(order, now, driverId);
  }

  acceptOrderOffer(orderId: string, driverId: string, now = Date.now(), expectedSessionVersion?: number): Order | undefined {
    if (expectedSessionVersion !== undefined) this.requireCurrentRole(driverId, "driver", expectedSessionVersion);
    const order = this.orders.get(orderId);
    if (!order || order.offeredDriverId !== driverId) return undefined;
    if (!hasLiveOrderOffer(order, now) || !this.isValidReservedOffer(order, now)) {
      if (order.externalPickup && order.status === "searching" && !order.driverId) {
        this.advanceOrderOffer(order, now, driverId);
      }
      return undefined;
    }
    const entry = this.queueEntries.get(driverId)!;
    const updated: Order = {
      ...order,
      driverId,
      status: order.pickupPoint === "D" ? "in_transit" : "en_route_to_c",
      offerExpiresAt: undefined,
      seatLockExpiresAt: order.pickupPoint === "D" ? undefined : now + (order.externalPickup
        ? externalPickupLeaseMs(order.externalPickup.roadDurationSeconds, order.externalPickup.settings)
        : SEAT_LOCK_TTL_MS),
      updatedAt: nextOrderUpdatedAt(order.updatedAt, now),
    };
    const accepted = acceptQueueOffer(entry, updated);
    this.orders.set(order.id, updated);
    this.queueEntries.set(driverId, accepted);
    return updated.routeContext ? structuredClone(updated) : updated;
  }

  processOrderOffers(now?: number): OrderOfferChange[] {
    const changes: OrderOfferChange[] = [];
    const searching = [...this.orders.values()]
      .filter(order => order.status === "searching" && !order.driverId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    const sweepTime = now ?? Date.now();
    const expired = searching.filter(order => order.offeredDriverId && !hasLiveOrderOffer(order, sweepTime));
    const waiting = searching.filter(order => !order.offeredDriverId);
    const live = searching.filter(order => hasLiveOrderOffer(order, sweepTime));
    for (const order of [...expired, ...waiting, ...live]) {
      const change = this.dispatchOrderOffer(order.id, now ?? Date.now());
      if (change) changes.push(change);
    }
    return changes;
  }

  transitionOrder(orderId: string, actorId: string, nextStatus: OrderStatus, expectedStatus?: OrderStatus, expectedSessionVersion?: number): Order | undefined {
    const order = this.orders.get(orderId);
    if (!order || !canTransitionOrder(order, actorId, nextStatus, expectedStatus)) return undefined;
    if (expectedSessionVersion !== undefined || nextStatus === "boarded_waiting") {
      const role = actorId === order.passengerId ? "passenger" : "driver";
      this.requireCurrentRole(actorId, role, expectedSessionVersion);
      if (role === "driver" && !hasRequiredDriverApproval(this.users.get(actorId), REQUIRE_DRIVER_APPROVAL)) {
        throw new AppError(403, "Driver approval is required", "DRIVER_NOT_APPROVED");
      }
    }
    const entry = order.driverId ? this.queueEntries.get(order.driverId) : undefined;
    assertLineOrderTransition(entry, order, nextStatus);
    if (entry) this.queueEntries.set(entry.driverId, transitionQueueEntry(entry, order, nextStatus));
    if (nextStatus === "cancelled" && order.status === "searching" && order.offeredDriverId) {
      const offeredEntry = this.queueEntries.get(order.offeredDriverId);
      if (offeredEntry) this.queueEntries.set(offeredEntry.driverId, releaseQueueOffer(offeredEntry, order));
    }
    const updated = this.writeOrder(order, {
      status: nextStatus,
      ...(nextStatus === "cancelled" ? { cancelledBy: actorId } : {}),
      seatLockExpiresAt: nextStatus === "boarded_waiting" || nextStatus === "in_transit" || nextStatus === "completed" || nextStatus === "cancelled"
        ? undefined : order.seatLockExpiresAt,
      offerExpiresAt: nextStatus === "cancelled" ? undefined : order.offerExpiresAt,
    });
    return updated.routeContext ? structuredClone(updated) : updated;
  }

  claimOrderForDriver(
    orderId: string,
    driverId: string,
    orderPatch: Partial<Order>,
    _queuePatch: Partial<QueueEntry>,
  ): Order | undefined {
    const order = this.orders.get(orderId);
    const entry = this.queueEntries.get(driverId);
    if (
      !order ||
      Boolean(order.routeContext) || order.pickupPoint === "A" || order.pickupPoint === "B" ||
      order.status !== "searching" ||
      (order.driverId && order.driverId !== driverId) ||
      (order.offeredDriverId && order.offeredDriverId !== driverId) ||
      order.offerExpiresAt !== undefined ||
      !entry ||
      Boolean(entry.routeContext) ||
      Boolean(entry.pendingOfferOrderId) ||
      entry.availableSeats < order.seats
    ) {
      return undefined;
    }
    const activePoolOffer =
      order.pickupPoint === "D" &&
      order.offeredDriverId === driverId &&
      entry.inFifo === false &&
      entry.status === "in_transit";
    if (!activePoolOffer && this.getQueuePosition(driverId) !== 1) {
      return undefined;
    }
    const expectedStatus = order.pickupPoint === "C" ? "en_route_to_c" : "in_transit";
    if (orderPatch.status !== undefined && orderPatch.status !== expectedStatus) return undefined;
    const updated = this.updateOrder(orderId, {
      ...orderPatch,
      status: expectedStatus,
      driverId,
      offeredDriverId: driverId,
    });
    if (!updated) return undefined;
    this.queueEntries.set(driverId, claimQueueEntry(entry, updated));
    return updated;
  }

  listOrdersForUser(userId: string): Order[] {
    return [...this.orders.values()]
      .filter((order) => order.passengerId === userId || order.driverId === userId ||
        (order.offeredDriverId === userId && hasLiveOrderOffer(order, Date.now())))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(order => order.routeContext ? structuredClone(order) : order);
  }

  listOrders(): Order[] {
    return [...this.orders.values()].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    ).map(order => order.routeContext ? structuredClone(order) : order);
  }

  listUsers(role?: User["role"]): User[] {
    return [...this.users.values()].filter((user) => !role || user.roles.includes(role)).map(user => structuredClone(user));
  }

  setDriverApproval(
    userId: string,
    status: DriverApprovalStatus,
    expectedVehicleRevision?: string | null,
  ): User | undefined {
    const user = this.users.get(userId);
    if (!user || !user.roles.includes("driver")) {
      return undefined;
    }
    assertVehicleReview(user, expectedVehicleRevision);
    user.driverApprovalStatus = status;
    return structuredClone(user);
  }

  listRoutes(): RouteDefinition[] {
    return [...this.routes.values()].map((route) => structuredClone(route));
  }

  getRoute(routeId: string): RouteDefinition | undefined {
    const route = this.routes.get(routeId);
    return route ? structuredClone(route) : undefined;
  }

  updateRouteLayout(routeId: string, input: RouteLayoutInput): RouteDefinition | undefined {
    const current = this.routes.get(routeId);
    if (!current) return undefined;
    const route = replaceRouteLayout(current, input);
    this.routes.set(routeId, route);
    return structuredClone(route);
  }

  createRoute(input: {
    id: string;
    name: string;
    pricePerStopKzt: number;
    active: boolean;
  }): RouteDefinition {
    if (this.routes.has(input.id)) {
      throw new Error(`Route ${input.id} already exists`);
    }
    const now = new Date().toISOString();
    const route: RouteDefinition = {
      id: input.id,
      name: input.name,
      currency: "KZT",
      pricePerStopKzt: input.pricePerStopKzt,
      active: input.active,
      stops: [],
      createdAt: now,
      updatedAt: now,
    };
    this.routes.set(route.id, route);
    return this.getRoute(route.id) as RouteDefinition;
  }

  updateRoute(
    routeId: string,
    patch: Partial<Pick<RouteDefinition, "name" | "pricePerStopKzt" | "active">>,
  ): RouteDefinition | undefined {
    const route = this.routes.get(routeId);
    if (!route) {
      return undefined;
    }
    this.routes.set(routeId, { ...route, ...patch, updatedAt: nextRouteUpdatedAt(route.updatedAt) });
    return this.getRoute(routeId);
  }

  deleteRoute(routeId: string): boolean {
    return this.routes.delete(routeId);
  }

  addRouteStop(
    routeId: string,
    input: { code: string; name: string; sequence?: number; position?: number },
  ): RouteStop | undefined {
    const route = this.routes.get(routeId);
    if (!route) {
      return undefined;
    }
    const changed = mutateRouteStop(route, { kind: "add", input });
    if (!changed?.stop) return undefined;
    this.routes.set(routeId, changed.route);
    return structuredClone(changed.stop);
  }

  updateRouteStop(
    routeId: string,
    stopId: string,
    patch: Partial<Pick<RouteStop, "code" | "name" | "sequence" | "position">>,
  ): RouteStop | undefined {
    const route = this.routes.get(routeId);
    if (!route) {
      return undefined;
    }
    const changed = mutateRouteStop(route, { kind: "update", stopId, patch });
    if (!changed?.stop) return undefined;
    this.routes.set(routeId, changed.route);
    return structuredClone(changed.stop);
  }

  deleteRouteStop(routeId: string, stopId: string): boolean {
    const route = this.routes.get(routeId);
    if (!route) {
      return false;
    }
    const changed = mutateRouteStop(route, { kind: "delete", stopId });
    if (!changed) return false;
    this.routes.set(routeId, changed.route);
    return true;
  }

  saveDeviceRegistration(
    userId: string,
    deviceToken: string,
    platform: DeviceRegistration["platform"],
  ): DeviceRegistration {
    const registration: DeviceRegistration = {
      userId,
      deviceToken,
      platform,
      createdAt: new Date().toISOString(),
    };
    this.deviceRegistrations.set(`${userId}:${deviceToken}`, registration);
    return registration;
  }

  getDeviceRegistrations(userId: string): DeviceRegistration[] {
    return [...this.deviceRegistrations.values()].filter(
      (registration) => registration.userId === userId,
    );
  }

  clearExpiredSeatLocks(): void {
    const now = Date.now();
    for (const order of this.orders.values()) {
      const entry = order.driverId ? this.queueEntries.get(order.driverId) : undefined;
      if (
        order.seatLockExpiresAt !== undefined &&
        order.seatLockExpiresAt <= now &&
        (order.status === "en_route_to_c" ||
          (order.status === "arrived_at_c" && Boolean(entry?.collectionState)))
      ) {
        const driverId = order.driverId;
        if (driverId) {
          if (entry) {
            this.queueEntries.set(driverId, releaseQueueEntry(entry, order));
          }
        }
        order.seatLockExpiresAt = undefined;
        order.driverId = undefined;
        order.offeredDriverId = undefined;
        order.offerExpiresAt = undefined;
        order.status = "searching";
        order.updatedAt = nextOrderUpdatedAt(order.updatedAt, now);
        if (order.externalPickup) this.orders.set(order.id, repriceExternalOrder(order, now));
      }
    }
    for (const entry of this.queueEntries.values()) {
      if (entry.seatLockExpiresAt && entry.seatLockExpiresAt <= now) {
        entry.seatLockExpiresAt = undefined;
      }
    }
  }

  queueSnapshot(): Array<QueueEntry & { position: number }> {
    return routeQueueSnapshot(this.getQueue());
  }

  static isDriverQueueStatus(status: string): status is DriverQueueStatus {
    return [
      "searching",
      "picking_up",
      "en_route_to_c",
      "arrived_at_c",
      "in_transit",
    ].includes(status);
  }

  static isOrderStatus(status: string): status is OrderStatus {
    return [
      "searching",
      "en_route_to_c",
      "arrived_at_c",
      "boarded_waiting",
      "in_transit",
      "completed",
      "cancelled",
    ].includes(status);
  }
}

export const store = new MemoryStore();
export { MemoryStore };
