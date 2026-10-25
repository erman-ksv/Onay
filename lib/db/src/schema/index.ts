import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Durable TezJet storage schema.
 *
 * Complex domain snapshots are retained as JSONB while frequently queried
 * identity/status/time fields are indexed as normal columns. This lets the
 * API migrate away from its in-memory store without losing nested fare,
 * location, route-stop, and pooling fields.
 */
export const usersTable = pgTable(
  "tezjet_users",
  {
    id: text("id").primaryKey(),
    role: text("role").notNull(),
    roles: jsonb("roles").$type<string[]>().notNull().default(["passenger"]),
    fullName: text("full_name").notNull(),
    phoneNumber: text("phone_number").notNull(),
    locale: text("locale").notNull(),
    profileLocked: boolean("profile_locked").notNull().default(true),
    sessionVersion: integer("session_version").notNull().default(0),
    driverApprovalStatus: text("driver_approval_status"),
    driverVehicle: jsonb("driver_vehicle").$type<Record<string, unknown> | null>(),
    driverRouteChoice: jsonb("driver_route_choice").$type<Record<string, unknown> | null>(),
    lastLocation: jsonb("last_location").$type<Record<string, unknown> | null>(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("tezjet_users_phone_number_uq").on(table.phoneNumber),
    index("tezjet_users_role_idx").on(table.role),
  ],
);

export const otpChallengesTable = pgTable(
  "tezjet_otp_challenges",
  {
    phoneNumber: text("phone_number").primaryKey(),
    code: text("code").notNull(),
    role: text("role").notNull(),
    locale: text("locale").notNull(),
    fullName: text("full_name"),
    expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
  },
  (table) => [index("tezjet_otp_challenges_expiry_idx").on(table.expiresAt)],
);

/** All identities in this table are purpose-separated keyed hashes. */
export interface OtpRateState {
  windowStartedAt: number;
  count: number;
  nextAllowedAt: number;
  blockedUntil: number;
}

export const otpRateLimitsTable = pgTable(
  "otp_rate_limits",
  {
    key: text("key").primaryKey(),
    state: jsonb("state").$type<OtpRateState>().notNull(),
    expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
  },
  (table) => [index("otp_rate_limits_expiry_idx").on(table.expiresAt)],
);

export const driverQueueTable = pgTable(
  "tezjet_driver_queue",
  {
    driverId: text("driver_id").primaryKey(),
    joinedAt: bigint("joined_at", { mode: "number" }).notNull(),
    status: text("status").notNull(),
    availableSeats: integer("available_seats").notNull(),
    lastLocation: jsonb("last_location").$type<Record<string, unknown>>().notNull(),
    routeContext: jsonb("route_context").$type<Record<string, unknown> | null>(),
    collectionState: jsonb("collection_state").$type<Record<string, unknown> | null>(),
    priorityLock: boolean("priority_lock").notNull().default(false),
    inFifo: boolean("in_fifo").notNull().default(true),
    activeOrderIds: jsonb("active_order_ids").$type<string[]>().notNull().default([]),
    currentOrderId: text("current_order_id"),
    pendingOfferOrderId: text("pending_offer_order_id"),
    seatLockExpiresAt: bigint("seat_lock_expires_at", { mode: "number" }),
  },
  (table) => [
    index("tezjet_driver_queue_fifo_idx").on(table.inFifo, table.priorityLock, table.joinedAt),
    index("tezjet_driver_queue_status_idx").on(table.status),
  ],
);

export const ordersTable = pgTable(
  "tezjet_orders",
  {
    id: text("id").primaryKey(),
    passengerId: text("passenger_id").notNull(),
    driverId: text("driver_id"),
    offeredDriverId: text("offered_driver_id"),
    offerExpiresAt: bigint("offer_expires_at", { mode: "number" }),
    status: text("status").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  },
  (table) => [
    index("tezjet_orders_passenger_created_idx").on(table.passengerId, table.createdAt),
    index("tezjet_orders_driver_created_idx").on(table.driverId, table.createdAt),
    index("tezjet_orders_status_created_idx").on(table.status, table.createdAt),
    index("tezjet_orders_offer_expiry_idx").on(table.status, table.offerExpiresAt),
    uniqueIndex("tezjet_orders_pending_driver_uq").on(table.offeredDriverId)
      .where(sql`${table.status} = 'searching' AND ${table.offeredDriverId} IS NOT NULL`),
  ],
);

/** A committed booking intent survives transport failures and server restarts.
 * Receipts deliberately outlive order deletion: a missing order must fail closed,
 * rather than make the same key eligible to reserve seats a second time.
 */
export const routeOrderRequestsTable = pgTable(
  "tezjet_route_order_requests",
  {
    passengerId: text("passenger_id").notNull(),
    requestKey: text("request_key").notNull(),
    requestHash: text("request_hash").notNull(),
    orderId: text("order_id").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [uniqueIndex("tezjet_route_order_requests_passenger_key_uq").on(table.passengerId, table.requestKey)],
);

export const deviceRegistrationsTable = pgTable(
  "tezjet_device_registrations",
  {
    userId: text("user_id").notNull(),
    deviceToken: text("device_token").notNull(),
    platform: text("platform").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("tezjet_device_user_token_uq").on(table.userId, table.deviceToken),
    index("tezjet_device_token_idx").on(table.deviceToken),
  ],
);

export const routesTable = pgTable("tezjet_routes", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  active: boolean("active").notNull().default(true),
  pricePerStopKzt: integer("price_per_stop_kzt").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
});


/** Append-only administrative action receipts; never store secrets or GPS. */
export const adminAuditEventsTable = pgTable("tezjet_admin_audit_events", {
  id: text("id").primaryKey(),
  actorId: text("actor_id").notNull(),
  action: text("action").notNull(),
  orderId: text("order_id"),
  driverId: text("driver_id"),
  vehicleRevision: text("vehicle_revision"),
  fromStatus: text("from_status").notNull(),
  toStatus: text("to_status").notNull(),
  createdAt: text("created_at").notNull(),
}, table => [
  index("tezjet_admin_audit_created_idx").on(table.createdAt, table.id),
  index("tezjet_admin_audit_order_created_idx").on(table.orderId, table.createdAt, table.id),
  index("tezjet_admin_audit_driver_created_idx").on(table.driverId, table.createdAt, table.id),
  uniqueIndex("tezjet_admin_audit_action_order_uq").on(table.action, table.orderId),
]);
