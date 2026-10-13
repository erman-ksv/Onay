import type {
  DeviceRegistration,
  DriverApprovalStatus,
  Locale,
  Order,
  OrderOfferChange,
  OrderStatus,
  OtpChallenge,
  PickupPoint,
  QueueEntry,
  RouteDefinition,
  RouteStop,
  User,
  UserRole,
} from "../types/domain";

/**
 * Storage contract shared by the in-memory test adapter and the PostgreSQL
 * runtime adapter. Methods may be synchronous in the memory adapter or
 * asynchronous in durable adapters; callers should await results before
 * switching production storage.
 */
export type MaybePromise<T> = T | Promise<T>;
export type { OrderOfferChange } from "../types/domain";

export interface Store {
  initialize(): MaybePromise<void>;
  createUser(input: {
    role: UserRole;
    fullName: string;
    phoneNumber: string;
    locale: Locale;
  }): MaybePromise<User>;
  getUser(userId: string): MaybePromise<User | undefined>;
  getUserByPhone(phoneNumber: string): MaybePromise<User | undefined>;
  updateUser(
    userId: string,
    patch: Partial<Pick<User, "locale" | "lastLocation">>,
  ): MaybePromise<User>;
  invalidateSessions(userId: string): MaybePromise<User>;

  saveOtp(challenge: OtpChallenge): MaybePromise<void>;
  consumeOtp(phoneNumber: string, code: string): MaybePromise<OtpChallenge | undefined>;

  getQueueEntry(driverId: string): MaybePromise<QueueEntry | undefined>;
  removeDriverFromFifo(driverId: string): MaybePromise<QueueEntry | undefined>;
  returnDriverToFifo(driverId: string): MaybePromise<QueueEntry | undefined>;
  joinQueue(entry: QueueEntry): MaybePromise<QueueEntry>;
  updateQueueEntry(
    driverId: string,
    patch: Partial<QueueEntry>,
  ): MaybePromise<QueueEntry | undefined>;
  leaveQueue(driverId: string): MaybePromise<void>;
  getQueue(): MaybePromise<QueueEntry[]>;
  getQueuePosition(driverId: string): MaybePromise<number | null>;
  getFirstEligibleDriver(seats: number): MaybePromise<QueueEntry | undefined>;
  getOrderAvailability(pickupPoint: PickupPoint, seats: number): MaybePromise<{ available: boolean; eligibleDriverCount: number }>;

  createOrder(input: Omit<Order, "id" | "createdAt" | "updatedAt">): MaybePromise<Order>;
  /** Create and reserve an offer atomically; unavailable requests persist no order. */
  createOrderWithOffer(input: Omit<Order, "id" | "createdAt" | "updatedAt">): MaybePromise<Order | undefined>;
  getOrder(orderId: string): MaybePromise<Order | undefined>;
  updateOrder(orderId: string, patch: Partial<Order>): MaybePromise<Order | undefined>;
  /** Reserve seats and the next eligible driver's single pending offer atomically. */
  dispatchOrderOffer(orderId: string, now?: number): MaybePromise<OrderOfferChange | undefined>;
  /** Release this driver's live offer and reserve the next eligible driver atomically. */
  rejectOrderOffer(orderId: string, driverId: string, now?: number): MaybePromise<OrderOfferChange | undefined>;
  /** Convert the live offer reservation into assigned seats without another debit. */
  acceptOrderOffer(orderId: string, driverId: string, now?: number): MaybePromise<Order | undefined>;
  /** Advance expired offers first, then dispatch searching orders oldest first. */
  processOrderOffers(now?: number): MaybePromise<OrderOfferChange[]>;
  /** Validate the live actor/state and update its seat reservation atomically. */
  transitionOrder(
    orderId: string,
    actorId: string,
    nextStatus: OrderStatus,
    expectedStatus?: OrderStatus,
  ): MaybePromise<Order | undefined>;
  claimOrderForDriver(
    orderId: string,
    driverId: string,
    orderPatch: Partial<Order>,
    queuePatch: Partial<QueueEntry>,
  ): MaybePromise<Order | undefined>;
  listOrdersForUser(userId: string): MaybePromise<Order[]>;
  listOrders(): MaybePromise<Order[]>;

  listUsers(role?: User["role"]): MaybePromise<User[]>;
  setDriverApproval(
    userId: string,
    status: DriverApprovalStatus,
  ): MaybePromise<User | undefined>;

  listRoutes(): MaybePromise<RouteDefinition[]>;
  getRoute(routeId: string): MaybePromise<RouteDefinition | undefined>;
  createRoute(input: {
    id: string;
    name: string;
    pricePerStopKzt: number;
    active: boolean;
  }): MaybePromise<RouteDefinition>;
  updateRoute(
    routeId: string,
    patch: Partial<Pick<RouteDefinition, "name" | "pricePerStopKzt" | "active">>,
  ): MaybePromise<RouteDefinition | undefined>;
  deleteRoute(routeId: string): MaybePromise<boolean>;
  addRouteStop(
    routeId: string,
    input: { code: string; name: string; sequence?: number; position?: number },
  ): MaybePromise<RouteStop | undefined>;
  updateRouteStop(
    routeId: string,
    stopId: string,
    patch: Partial<Pick<RouteStop, "code" | "name" | "sequence" | "position">>,
  ): MaybePromise<RouteStop | undefined>;
  deleteRouteStop(routeId: string, stopId: string): MaybePromise<boolean>;

  saveDeviceRegistration(
    userId: string,
    deviceToken: string,
    platform: DeviceRegistration["platform"],
  ): MaybePromise<DeviceRegistration>;
  getDeviceRegistrations(userId: string): MaybePromise<DeviceRegistration[]>;

  clearExpiredSeatLocks(): MaybePromise<void>;
  queueSnapshot(): MaybePromise<Array<QueueEntry & { position: number }>>;
}

