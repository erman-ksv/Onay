import { randomUUID } from "node:crypto";
import { OFFER_TIMEOUT_MS, REQUIRE_DRIVER_APPROVAL, SEAT_LOCK_TTL_MS } from "../utils/config";
import type { Store } from "./storeContract";
import { canTransitionOrder, claimQueueEntry, hasActiveOrders, joinQueueEntry, releaseQueueEntry, transitionQueueEntry } from "./orderLifecycle";
import { AppError } from "../utils/errors";
import { acceptQueueOffer, assertOrderOfferPatch, assertQueueOfferPatch, compareOfferDrivers, hasLiveOrderOffer, orderedOfferCandidates, releaseQueueOffer, reserveQueueOffer } from "./orderOffers";
import type {
  Coordinates,
  DeviceRegistration,
  DriverQueueStatus,
  DriverApprovalStatus,
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
  private readonly queueEntries = new Map<string, QueueEntry>();
  private readonly orders = new Map<string, Order>();
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
    return user;
  }

  getUser(userId: string): User | undefined {
    return this.users.get(userId);
  }

  getUserByPhone(phoneNumber: string): User | undefined {
    const userId = this.usersByPhone.get(phoneNumber);
    return userId ? this.users.get(userId) : undefined;
  }

  updateUser(userId: string, patch: Partial<Pick<User, "locale" | "lastLocation">>): User {
    const user = this.users.get(userId);
    if (!user) {
      throw new Error(`User ${userId} not found`);
    }
    Object.assign(user, patch);
    return user;
  }

  invalidateSessions(userId: string): User {
    const user = this.users.get(userId);
    if (!user) {
      throw new Error(`User ${userId} not found`);
    }
    user.sessionVersion += 1;
    return user;
  }

  saveOtp(challenge: OtpChallenge): void {
    this.otpChallenges.set(challenge.phoneNumber, challenge);
  }

  consumeOtp(phoneNumber: string, code: string): OtpChallenge | undefined {
    const challenge = this.otpChallenges.get(phoneNumber);
    if (!challenge || challenge.code !== code || challenge.expiresAt < Date.now()) {
      return undefined;
    }
    this.otpChallenges.delete(phoneNumber);
    return challenge;
  }

  getQueueEntry(driverId: string): QueueEntry | undefined {
    return this.queueEntries.get(driverId);
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

  joinQueue(entry: QueueEntry): QueueEntry {
    const current = this.queueEntries.get(entry.driverId);
    if (current && (hasActiveOrders(current) || current.pendingOfferOrderId || current.inFifo === false)) {
      throw new AppError(409, "Driver cannot rejoin while an order or route is active", "QUEUE_BUSY");
    }
    const joined = joinQueueEntry({ ...entry, pendingOfferOrderId: undefined }, current);
    this.queueEntries.set(entry.driverId, joined);
    return joined;
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
    Object.assign(entry, patch);
    return entry;
  }

  leaveQueue(driverId: string): void {
    const current = this.queueEntries.get(driverId);
    if (current && (hasActiveOrders(current) || current.pendingOfferOrderId)) {
      throw new AppError(409, "Driver cannot leave the queue while an order is active", "ACTIVE_ORDER");
    }
    this.queueEntries.delete(driverId);
  }

  getQueue(): QueueEntry[] {
    return [...this.queueEntries.values()]
      .filter((entry) => entry.inFifo !== false)
      .filter((entry) => !entry.seatLockExpiresAt || entry.seatLockExpiresAt > Date.now())
      .sort(compareOfferDrivers);
  }

  getQueuePosition(driverId: string): number | null {
    const index = this.getQueue().findIndex((entry) => entry.driverId === driverId);
    return index === -1 ? null : index + 1;
  }

  getFirstEligibleDriver(seats: number): QueueEntry | undefined {
    return [...this.queueEntries.values()].sort(compareOfferDrivers).find(
      (entry) =>
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
      !REQUIRE_DRIVER_APPROVAL || this.users.get(entry.driverId)?.driverApprovalStatus === "approved",
    );
  }

  getOrderAvailability(pickupPoint: PickupPoint, seats: number): { available: boolean; eligibleDriverCount: number } {
    const eligibleDriverCount = orderedOfferCandidates({ pickupPoint, seats }, this.eligibleOfferEntries(), Date.now()).length;
    return { available: eligibleDriverCount > 0, eligibleDriverCount };
  }

  createOrder(input: Omit<Order, "id" | "createdAt" | "updatedAt">): Order {
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

  createOrderWithOffer(input: Omit<Order, "id" | "createdAt" | "updatedAt">): Order | undefined {
    const now = Date.now();
    const next = orderedOfferCandidates(
      { pickupPoint: input.pickupPoint, seats: input.seats }, this.eligibleOfferEntries(), now,
    )[0];
    if (!next) return undefined;
    const timestamp = new Date(now).toISOString();
    const order: Order = {
      ...input,
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
    return order;
  }

  getOrder(orderId: string): Order | undefined {
    return this.orders.get(orderId);
  }

  updateOrder(orderId: string, patch: Partial<Order>): Order | undefined {
    const order = this.orders.get(orderId);
    if (!order) {
      return undefined;
    }
    assertOrderOfferPatch(order, patch);
    return this.writeOrder(order, patch);
  }

  private writeOrder(order: Order, patch: Partial<Order>, now = Date.now()): Order {
    Object.assign(order, patch, { id: order.id, updatedAt: new Date(now).toISOString() });
    return order;
  }

  private isValidReservedOffer(order: Order, now: number): boolean {
    const entry = order.offeredDriverId ? this.queueEntries.get(order.offeredDriverId) : undefined;
    if (!entry || entry.pendingOfferOrderId !== order.id || entry.availableSeats < 0) return false;
    if (REQUIRE_DRIVER_APPROVAL && this.users.get(entry.driverId)?.driverApprovalStatus !== "approved") return false;
    return orderedOfferCandidates(
      { ...order, attemptedDriverIds: [] },
      [{ ...entry, pendingOfferOrderId: undefined, availableSeats: entry.availableSeats + order.seats }],
      now,
    ).length > 0;
  }

  private advanceOrderOffer(order: Order, now: number, previousDriverId?: string): OrderOfferChange | undefined {
    const previousEntry = previousDriverId ? this.queueEntries.get(previousDriverId) : undefined;
    if (previousEntry) {
      this.queueEntries.set(previousEntry.driverId, releaseQueueOffer(previousEntry, order));
    }
    const attemptedDriverIds = [...new Set([
      ...(order.attemptedDriverIds ?? []),
      ...(previousDriverId ? [previousDriverId] : []),
    ])];
    const next = orderedOfferCandidates({ ...order, attemptedDriverIds }, this.eligibleOfferEntries(), now)[0];
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
    return { order: { ...order }, ...(previousDriverId ? { previousDriverId } : {}) };
  }

  dispatchOrderOffer(orderId: string, now = Date.now()): OrderOfferChange | undefined {
    const order = this.orders.get(orderId);
    if (!order || order.status !== "searching" || order.driverId) return undefined;
    if (hasLiveOrderOffer(order, now) && this.isValidReservedOffer(order, now)) return undefined;
    return this.advanceOrderOffer(order, now, order.offeredDriverId);
  }

  rejectOrderOffer(orderId: string, driverId: string, now = Date.now()): OrderOfferChange | undefined {
    const order = this.orders.get(orderId);
    if (!order || order.offeredDriverId !== driverId || !hasLiveOrderOffer(order, now) ||
      this.queueEntries.get(driverId)?.pendingOfferOrderId !== order.id) return undefined;
    return this.advanceOrderOffer(order, now, driverId);
  }

  acceptOrderOffer(orderId: string, driverId: string, now = Date.now()): Order | undefined {
    const order = this.orders.get(orderId);
    if (!order || order.offeredDriverId !== driverId || !hasLiveOrderOffer(order, now) ||
      !this.isValidReservedOffer(order, now)) return undefined;
    const entry = this.queueEntries.get(driverId)!;
    const updated = this.writeOrder(order, {
      driverId,
      status: order.pickupPoint === "C" ? "en_route_to_c" : "in_transit",
      offerExpiresAt: undefined,
      seatLockExpiresAt: order.pickupPoint === "C" ? now + SEAT_LOCK_TTL_MS : undefined,
    }, now);
    this.queueEntries.set(driverId, acceptQueueOffer(entry, updated));
    return updated;
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

  transitionOrder(orderId: string, actorId: string, nextStatus: OrderStatus, expectedStatus?: OrderStatus): Order | undefined {
    const order = this.orders.get(orderId);
    if (!order || !canTransitionOrder(order, actorId, nextStatus, expectedStatus)) return undefined;
    const entry = order.driverId ? this.queueEntries.get(order.driverId) : undefined;
    if (entry) this.queueEntries.set(entry.driverId, transitionQueueEntry(entry, order, nextStatus));
    if (nextStatus === "cancelled" && order.status === "searching" && order.offeredDriverId) {
      const offeredEntry = this.queueEntries.get(order.offeredDriverId);
      if (offeredEntry) this.queueEntries.set(offeredEntry.driverId, releaseQueueOffer(offeredEntry, order));
    }
    return this.writeOrder(order, {
      status: nextStatus,
      ...(nextStatus === "cancelled" ? { cancelledBy: actorId } : {}),
      seatLockExpiresAt: nextStatus === "in_transit" || nextStatus === "completed" || nextStatus === "cancelled"
        ? undefined : order.seatLockExpiresAt,
      offerExpiresAt: nextStatus === "cancelled" ? undefined : order.offerExpiresAt,
    });
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
      order.status !== "searching" ||
      (order.driverId && order.driverId !== driverId) ||
      (order.offeredDriverId && order.offeredDriverId !== driverId) ||
      order.offerExpiresAt !== undefined ||
      !entry ||
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
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  listOrders(): Order[] {
    return [...this.orders.values()].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
  }

  listUsers(role?: User["role"]): User[] {
    return [...this.users.values()].filter((user) => !role || user.role === role);
  }

  setDriverApproval(
    userId: string,
    status: DriverApprovalStatus,
  ): User | undefined {
    const user = this.users.get(userId);
    if (!user || user.role !== "driver") {
      return undefined;
    }
    user.driverApprovalStatus = status;
    return user;
  }

  listRoutes(): RouteDefinition[] {
    return [...this.routes.values()].map((route) => ({
      ...route,
      stops: route.stops.map((stop) => ({ ...stop })),
    }));
  }

  getRoute(routeId: string): RouteDefinition | undefined {
    const route = this.routes.get(routeId);
    return route
      ? { ...route, stops: route.stops.map((stop) => ({ ...stop })) }
      : undefined;
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
    Object.assign(route, patch, { updatedAt: new Date().toISOString() });
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
    const sequence = input.sequence ?? route.stops.length + 1;
    const position = input.position ?? sequence;
    const stop: RouteStop = {
      id: randomUUID(),
      code: input.code,
      name: input.name,
      sequence,
      position,
    };
    route.stops.push(stop);
    route.stops.sort((a, b) => a.sequence - b.sequence);
    route.updatedAt = new Date().toISOString();
    return { ...stop };
  }

  updateRouteStop(
    routeId: string,
    stopId: string,
    patch: Partial<Pick<RouteStop, "code" | "name" | "sequence" | "position">>,
  ): RouteStop | undefined {
    const route = this.routes.get(routeId);
    const stop = route?.stops.find((candidate) => candidate.id === stopId);
    if (!route || !stop) {
      return undefined;
    }
    Object.assign(stop, patch);
    route.stops.sort((a, b) => a.sequence - b.sequence);
    route.updatedAt = new Date().toISOString();
    return { ...stop };
  }

  deleteRouteStop(routeId: string, stopId: string): boolean {
    const route = this.routes.get(routeId);
    if (!route) {
      return false;
    }
    const originalLength = route.stops.length;
    route.stops = route.stops.filter((stop) => stop.id !== stopId);
    if (route.stops.length === originalLength) {
      return false;
    }
    route.updatedAt = new Date().toISOString();
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
      if (
        order.seatLockExpiresAt &&
        order.seatLockExpiresAt <= now &&
        order.status === "en_route_to_c"
      ) {
        const driverId = order.driverId;
        if (driverId) {
          const entry = this.queueEntries.get(driverId);
          if (entry) {
            this.queueEntries.set(driverId, releaseQueueEntry(entry, order));
          }
        }
        order.seatLockExpiresAt = undefined;
        order.driverId = undefined;
        order.offeredDriverId = undefined;
        order.offerExpiresAt = undefined;
        order.status = "searching";
        order.updatedAt = new Date().toISOString();
      }
    }
    for (const entry of this.queueEntries.values()) {
      if (entry.seatLockExpiresAt && entry.seatLockExpiresAt <= now) {
        entry.seatLockExpiresAt = undefined;
      }
    }
  }

  queueSnapshot(): Array<QueueEntry & { position: number }> {
    return this.getQueue().map((entry, index) => ({
      ...entry,
      position: index + 1,
    }));
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
      "in_transit",
      "completed",
      "cancelled",
    ].includes(status);
  }
}

export const store = new MemoryStore();
export { MemoryStore };
