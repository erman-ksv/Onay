import type {
  AdminAuditEvent,
  DeviceRegistration,
  Coordinates,
  DriverApprovalStatus,
  DriverVehicleInput,
  DriverRouteChoice,
  DriverRouteDirection,
  FareQuote,
  FareCurrency,
  ExternalPickupQuote,
  ExternalPickupSelectionInput,
  ExternalPickupSettings,
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
export interface RouteCreateInput {
  id: string;
  name: string;
  currency?: FareCurrency;
  pricePerStop?: number;
  pricePerStopKzt?: number;
  active: boolean;
}
export type RouteMetadataPatch = Partial<Pick<RouteDefinition, "name" | "currency" | "pricePerStop" | "pricePerStopKzt" | "active">>;

export type MaybePromise<T> = T | Promise<T>;
/** A closed key is durably fenced against every later booking attempt. */
export type RouteOrderResolution = { state: "created"; order: Order } | { state: "closed"; requestKey: string };
export interface AdminMutationActor { adminId: string; expectedSessionVersion: number }
export type { OrderOfferChange } from "../types/domain";
export type { ExternalPickupQuote, ExternalPickupSelectionInput, ExternalPickupSettings } from "../types/domain";

export type OtpLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfterMs: number };

export type OtpVerifyResult =
  | { status: "verified"; challenge: OtpChallenge }
  | { status: "invalid" }
  | { status: "limited"; retryAfterMs: number };

export interface RouteLayoutInput {
  expectedUpdatedAt: string;
  stops: Array<{
    id?: string;
    code: string;
    name: string;
    location?: { lat: number; lng: number };
  }>;
  pitaks?: {
    aStopCode: string;
    bStopCode: string;
    radiusMeters: number;
  };
}

export interface DriverRouteChoiceInput {
  routeId: string;
  direction: DriverRouteDirection;
  expectedUpdatedAt: string;
}

/** Passenger stop selectors are distinct from the driver's saved lane choice. */
export interface RouteOrderSelectionInput extends DriverRouteChoiceInput {
  pickupStopId?: string;
  destinationStopId?: string;
}

export interface RouteOrderAvailability {
  available: boolean;
  eligibleDriverCount: number;
  fare: FareQuote;
}

/** A passenger chooses a configured direction, never its fare or route geometry. */
export interface RouteOrderInput {
  passengerId: string;
  passengerPhone: string;
  pickupLocation: Coordinates;
  seats: number;
}

export interface RouteOrderReceipt {
  order: Order;
  requestHash: string;
}

export interface Store {
  initialize(): MaybePromise<void>;
  createUser(input: {
    role: UserRole;
    fullName: string;
    phoneNumber: string;
    locale: Locale;
  }): MaybePromise<User>;
  getUser(userId: string): MaybePromise<User | undefined>;
  setDriverVehicle(userId: string, input: DriverVehicleInput, expectedSessionVersion: number): MaybePromise<User>;
  getUserByPhone(phoneNumber: string): MaybePromise<User | undefined>;
  updateUser(
    userId: string,
    patch: Partial<Pick<User, "locale" | "lastLocation">>,
  ): MaybePromise<User>;
  invalidateSessions(userId: string): MaybePromise<User>;
  /** Activate a non-admin mode and invalidate the previous session atomically. */
  activateUserRole(userId: string, nextRole: "passenger" | "driver", expectedSessionVersion?: number): MaybePromise<User>;
  /** Change planning preference only while the live driver has no queue/order work. */
  setDriverRouteChoice(userId: string, input: DriverRouteChoiceInput | null, expectedSessionVersion: number): MaybePromise<DriverRouteChoice | null>;

  /** Trusted internal fixture/seed operation; HTTP callers use the protected methods. */
  saveOtp(challenge: OtpChallenge): MaybePromise<void>;
  /** Trusted internal consume operation; HTTP callers use the protected methods. */
  consumeOtp(phoneNumber: string, code: string): MaybePromise<OtpChallenge | undefined>;
  /** Independently commit the client's shared request budget before validating an OTP body. */
  takeOtpIpBudget(clientKey: string): MaybePromise<OtpLimitResult>;
  /** Atomically enforce phone send/failure budgets and replace its challenge. */
  saveOtpProtected(challenge: OtpChallenge): MaybePromise<OtpLimitResult>;
  /** Consume once or commit a failed attempt while holding the same phone locks as resend. */
  consumeOtpProtected(phoneNumber: string, code: string): MaybePromise<OtpVerifyResult>;

  getQueueEntry(driverId: string): MaybePromise<QueueEntry | undefined>;
  removeDriverFromFifo(driverId: string): MaybePromise<QueueEntry | undefined>;
  returnDriverToFifo(driverId: string): MaybePromise<QueueEntry | undefined>;
  joinQueue(entry: QueueEntry, expectedSessionVersion?: number, selection?: DriverRouteChoiceInput, collectionMode?: boolean): MaybePromise<QueueEntry>;
  /** Only this action departs an opt-in line; a repeat cannot depart a new enrollment. */
  departQueue(driverId: string, expectedEnrollmentId: string, expectedSessionVersion?: number): MaybePromise<{ entry: QueueEntry; orders: Order[]; changed: boolean }>;
  updateQueueEntry(
    driverId: string,
    patch: Partial<QueueEntry>,
  ): MaybePromise<QueueEntry | undefined>;
  leaveQueue(driverId: string): MaybePromise<void>;
  getQueue(): MaybePromise<QueueEntry[]>;
  getQueuePosition(driverId: string): MaybePromise<number | null>;
  getFirstEligibleDriver(seats: number): MaybePromise<QueueEntry | undefined>;
  getOrderAvailability(pickupPoint: PickupPoint, seats: number): MaybePromise<{ available: boolean; eligibleDriverCount: number }>;
  getRouteOrderAvailability(selection: RouteOrderSelectionInput, seats: number): MaybePromise<RouteOrderAvailability>;
  /** Derive live route/fare and reserve one matching lane atomically. */
  createRouteOrderWithOffer(input: RouteOrderInput, selection: RouteOrderSelectionInput, expectedSessionVersion?: number): MaybePromise<Order | undefined>;
  /** Resolve a passenger-owned booking without repeating GPS, fare or seat allocation. */
  getRouteOrderRequest(passengerId: string, requestKey: string, expectedSessionVersion?: number): MaybePromise<RouteOrderReceipt | undefined>;
  resolveRouteOrderRequest(passengerId: string, requestKey: string, expectedSessionVersion?: number): MaybePromise<RouteOrderResolution>;
  /** Persist the receipt and reservation together; replay never reserves seats again. */
  createRouteOrderOnce(input: RouteOrderInput, selection: RouteOrderSelectionInput, requestKey: string, expectedSessionVersion?: number): MaybePromise<{ order: Order; created: boolean } | undefined>;
  /** Advisory snapshot only; road routing happens outside transaction locks. */
  getExternalPickupCandidates(selection: ExternalPickupSelectionInput, seats: number, excludedDriverIds?: string[]): MaybePromise<{ route: RouteDefinition; candidates: QueueEntry[] }>;
  /** Confirm only the signed driver/price; initial quote ID is the order's immutable primary key. */
  confirmExternalPickupQuote(quote: ExternalPickupQuote, passengerId: string, expectedSessionVersion: number): MaybePromise<{ order: Order; created: boolean; changed: boolean }>;

  createOrder(input: Omit<Order, "id" | "createdAt" | "updatedAt">, expectedSessionVersion?: number): MaybePromise<Order>;
  /** Create and reserve an offer atomically; unavailable requests persist no order. */
  createOrderWithOffer(input: Omit<Order, "id" | "createdAt" | "updatedAt">, expectedSessionVersion?: number): MaybePromise<Order | undefined>;
  getOrder(orderId: string): MaybePromise<Order | undefined>;
  updateOrder(orderId: string, patch: Partial<Order>): MaybePromise<Order | undefined>;
  /** Reserve seats and the next eligible driver's single pending offer atomically. */
  dispatchOrderOffer(orderId: string, now?: number): MaybePromise<OrderOfferChange | undefined>;
  /** Release this driver's live offer and reserve the next eligible driver atomically. */
  rejectOrderOffer(orderId: string, driverId: string, now?: number, expectedSessionVersion?: number): MaybePromise<OrderOfferChange | undefined>;
  /** Convert the live offer reservation into assigned seats without another debit. */
  acceptOrderOffer(orderId: string, driverId: string, now?: number, expectedSessionVersion?: number): MaybePromise<Order | undefined>;
  /** Advance expired offers first, then dispatch searching orders oldest first. */
  processOrderOffers(now?: number): MaybePromise<OrderOfferChange[]>;
  /** Validate the live actor/state and update its seat reservation atomically. */
  transitionOrder(
    orderId: string,
    actorId: string,
    nextStatus: OrderStatus,
    expectedStatus?: OrderStatus,
    expectedSessionVersion?: number,
  ): MaybePromise<Order | undefined>;
  cancelOrderAsAdmin(orderId: string, adminId: string, expectedStatus: OrderStatus, expectedSessionVersion: number): MaybePromise<Order | undefined>;
  listAdminAuditEvents(orderId?: string, limit?: number, driverId?: string, routeId?: string): MaybePromise<AdminAuditEvent[]>;
  setDriverApprovalAsAdmin(userId: string, status: DriverApprovalStatus, expectedVehicleRevision: string | null | undefined, adminId: string, expectedSessionVersion: number): MaybePromise<User | undefined>;
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
    expectedVehicleRevision?: string | null,
  ): MaybePromise<User | undefined>;

  listRoutes(): MaybePromise<RouteDefinition[]>;
  getRoute(routeId: string): MaybePromise<RouteDefinition | undefined>;
  updateExternalPickupSettings(routeId: string, input: { expectedUpdatedAt: string; settings: ExternalPickupSettings }): MaybePromise<RouteDefinition | undefined>;
  /** Replace only the ordered static layout, rejecting a stale route version. */
  updateRouteLayout(routeId: string, input: RouteLayoutInput): MaybePromise<RouteDefinition | undefined>;
  createRoute(input: RouteCreateInput): MaybePromise<RouteDefinition>;
  updateRoute(routeId: string, patch: RouteMetadataPatch, audit?: AdminMutationActor): MaybePromise<RouteDefinition | undefined>;
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

