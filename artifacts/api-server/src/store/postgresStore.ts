import { createHmac, randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { DriverRouteChoiceInput, RouteLayoutInput, RouteOrderInput, Store } from "./storeContract";
import { mutateRouteStop, nextRouteUpdatedAt, replaceRouteLayout } from "../utils/routeLayout";
import { assertDriverRouteChoiceRoute, validateDriverRouteChoiceInput } from "../utils/driverRoute";
import { canTransitionOrder, claimQueueEntry, hasActiveOrders, joinQueueEntry, releaseQueueEntry, transitionQueueEntry } from "./orderLifecycle";
import { AppError } from "../utils/errors";
import { assertRouteQueueTelemetry, resolveRouteQueue, routeQueueSnapshot, sameQueueLane } from "../utils/routeQueue";
import type {
  Coordinates,
  DeviceRegistration,
  DriverApprovalStatus,
  DriverRouteChoice,
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
import { OFFER_TIMEOUT_MS, REQUIRE_DRIVER_APPROVAL, SEAT_LOCK_TTL_MS } from "../utils/config";
import { acceptQueueOffer, assertLegacyOrderInput, assertOrderOfferPatch, assertQueueOfferPatch, compareOfferDrivers, hasLiveOrderOffer, orderedOfferCandidates, releaseQueueOffer, reserveQueueOffer } from "./orderOffers";
import { buildRouteOrder } from "../utils/routeOrder";
import { boundedInteger } from "../utils/validation";

type DbModule = typeof import("@workspace/db");

function otpDigest(code: string): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret && process.env.NODE_ENV === "production") {
    throw new Error("SESSION_SECRET is required to protect stored OTP challenges");
  }
  return createHmac("sha256", secret ?? "tezjet-development-otp-key").update(code).digest("hex");
}

function asUser(row: Record<string, unknown>): User {
  return {
    id: String(row.id),
    role: row.role as UserRole,
    roles: (row.roles ?? [row.role]) as UserRole[],
    fullName: String(row.fullName),
    phoneNumber: String(row.phoneNumber),
    locale: row.locale as Locale,
    profileLocked: Boolean(row.profileLocked),
    sessionVersion: Number(row.sessionVersion),
    driverApprovalStatus: row.driverApprovalStatus as DriverApprovalStatus | undefined,
    ...(row.driverRouteChoice == null ? {} : {
      driverRouteChoice: structuredClone(row.driverRouteChoice) as DriverRouteChoice,
    }),
    lastLocation: (row.lastLocation ?? undefined) as Coordinates | undefined,
    createdAt: String(row.createdAt),
  };
}

function asQueueEntry(row: Record<string, unknown>): QueueEntry {
  return {
    driverId: String(row.driverId),
    joinedAt: Number(row.joinedAt),
    status: row.status as QueueEntry["status"],
    availableSeats: Number(row.availableSeats),
    lastLocation: row.lastLocation as Coordinates,
    priorityLock: Boolean(row.priorityLock),
    inFifo: row.inFifo === undefined ? true : Boolean(row.inFifo),
    activeOrderIds: (row.activeOrderIds ?? []) as string[],
    currentOrderId: (row.currentOrderId ?? undefined) as string | undefined,
    pendingOfferOrderId: (row.pendingOfferOrderId ?? undefined) as string | undefined,
    seatLockExpiresAt: (row.seatLockExpiresAt ?? undefined) as number | undefined,
    ...(row.routeContext == null ? {} : { routeContext: structuredClone(row.routeContext) as QueueEntry["routeContext"] }),
  };
}

function asOrder(row: Record<string, unknown>): Order {
  return {
    ...(row.payload as Order),
    id: String(row.id),
    passengerId: String(row.passengerId),
    driverId: (row.driverId ?? undefined) as string | undefined,
    offeredDriverId: (row.offeredDriverId ?? undefined) as string | undefined,
    offerExpiresAt: row.offerExpiresAt == null ? undefined : Number(row.offerExpiresAt),
    status: row.status as Order["status"],
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}

function queueValues(entry: QueueEntry) {
  return {
    joinedAt: entry.joinedAt,
    status: entry.status,
    availableSeats: entry.availableSeats,
    lastLocation: entry.lastLocation as unknown as Record<string, unknown>,
    priorityLock: entry.priorityLock,
    inFifo: entry.inFifo !== false,
    activeOrderIds: entry.activeOrderIds ?? [],
    currentOrderId: entry.currentOrderId ?? null,
    pendingOfferOrderId: entry.pendingOfferOrderId ?? null,
    seatLockExpiresAt: entry.seatLockExpiresAt ?? null,
    routeContext: entry.routeContext as unknown as Record<string, unknown> ?? null,
  };
}

function orderValues(order: Order) {
  return {
    driverId: order.driverId ?? null,
    offeredDriverId: order.offeredDriverId ?? null,
    offerExpiresAt: order.offerExpiresAt ?? null,
    status: order.status,
    updatedAt: order.updatedAt,
    payload: order as unknown as Record<string, unknown>,
  };
}

/** A reserved offer must still belong to the same eligible queue entry. */
function queueOwnsEligibleOffer(entry: QueueEntry | undefined, order: Order, now: number, liveRoute?: RouteDefinition): boolean {
  if (!entry || entry.pendingOfferOrderId !== order.id) return false;
  return orderedOfferCandidates(
    { ...order, attemptedDriverIds: [] },
    [{ ...entry, pendingOfferOrderId: undefined, availableSeats: entry.availableSeats + order.seats }],
    now,
    liveRoute,
  ).length > 0;
}

function asRoute(row: Record<string, unknown>): RouteDefinition {
  return row.payload as RouteDefinition;
}

const defaultRoute: RouteDefinition = {
  id: "pyatak",
  name: "Pyatak",
  currency: "KZT",
  pricePerStopKzt: 500,
  active: true,
  stops: [
    { id: "pyatak-stop-c", code: "C", name: "Point C", sequence: 1, position: 1 },
    { id: "pyatak-stop-d", code: "D", name: "Point D", sequence: 2, position: 2 },
  ],
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
};

/**
 * PostgreSQL-backed implementation of the Store contract.
 *
 * DATABASE_URL is required. Importing the DB package is delayed until the
 * first operation so test environments can explicitly use MemoryStore.
 */
export class PostgresStore implements Store {
  private modulePromise?: Promise<DbModule>;

  async initialize(): Promise<void> {
    await this.database();
  }

  private async database(): Promise<DbModule> {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL is required to use PostgresStore");
    }
    if (!this.modulePromise) {
      this.modulePromise = (async () => {
        const mod = await import("@workspace/db");
        const now = new Date().toISOString();
        const seededRoute = { ...defaultRoute, createdAt: now, updatedAt: now };
        await mod.db
          .insert(mod.routesTable)
          .values({
            id: seededRoute.id,
            name: seededRoute.name,
            active: seededRoute.active,
            pricePerStopKzt: seededRoute.pricePerStopKzt,
            createdAt: seededRoute.createdAt,
            updatedAt: seededRoute.updatedAt,
            payload: seededRoute as unknown as Record<string, unknown>,
          })
          .onConflictDoNothing();
        return mod;
      })();
    }
    return this.modulePromise;
  }

  async createUser(input: {
    role: UserRole;
    fullName: string;
    phoneNumber: string;
    locale: Locale;
  }): Promise<User> {
    const { db, usersTable } = await this.database();
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
    const [row] = await db.insert(usersTable).values({
      id: user.id,
      role: user.role,
      roles: user.roles,
      fullName: user.fullName,
      phoneNumber: user.phoneNumber,
      locale: user.locale,
      profileLocked: user.profileLocked,
      sessionVersion: user.sessionVersion,
      driverApprovalStatus: user.driverApprovalStatus ?? null,
      lastLocation: user.lastLocation ? user.lastLocation as unknown as Record<string, unknown> : null,
      createdAt: user.createdAt,
    }).returning();
    return asUser(row as unknown as Record<string, unknown>);
  }

  async getUser(userId: string): Promise<User | undefined> {
    const { db, usersTable } = await this.database();
    const [row] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
    return row ? asUser(row as unknown as Record<string, unknown>) : undefined;
  }

  async getUserByPhone(phoneNumber: string): Promise<User | undefined> {
    const { db, usersTable } = await this.database();
    const [row] = await db.select().from(usersTable).where(eq(usersTable.phoneNumber, phoneNumber)).limit(1);
    return row ? asUser(row as unknown as Record<string, unknown>) : undefined;
  }

  async updateUser(
    userId: string,
    patch: Partial<Pick<User, "locale" | "lastLocation">>,
  ): Promise<User> {
    const { db, usersTable } = await this.database();
    const values: { locale?: Locale; lastLocation?: Record<string, unknown> | null } = {};
    if (patch.locale !== undefined) values.locale = patch.locale;
    if (patch.lastLocation !== undefined) values.lastLocation = patch.lastLocation as unknown as Record<string, unknown>;
    const [row] = await db.update(usersTable).set(values).where(eq(usersTable.id, userId)).returning();
    if (!row) throw new Error(`User ${userId} not found`);
    return asUser(row as unknown as Record<string, unknown>);
  }

  async invalidateSessions(userId: string): Promise<User> {
    const { db, usersTable } = await this.database();
    const [row] = await db.update(usersTable)
      .set({ sessionVersion: sql`${usersTable.sessionVersion} + 1` })
      .where(eq(usersTable.id, userId))
      .returning();
    if (!row) throw new Error(`User ${userId} not found`);
    return asUser(row as unknown as Record<string, unknown>);
  }

  async saveOtp(challenge: OtpChallenge): Promise<void> {
    const { db, otpChallengesTable } = await this.database();
    await db.insert(otpChallengesTable).values({
      phoneNumber: challenge.phoneNumber,
      code: otpDigest(challenge.code),
      role: challenge.role,
      locale: challenge.locale,
      fullName: challenge.fullName ?? null,
      expiresAt: challenge.expiresAt,
    }).onConflictDoUpdate({
      target: otpChallengesTable.phoneNumber,
      set: {
        code: otpDigest(challenge.code),
        role: challenge.role,
        locale: challenge.locale,
        fullName: challenge.fullName ?? null,
        expiresAt: challenge.expiresAt,
      },
    });
  }

  async activateUserRole(userId: string, nextRole: "passenger" | "driver", expectedSessionVersion?: number): Promise<User> {
    if (nextRole !== "passenger" && nextRole !== "driver") {
      throw new AppError(400, "Only passenger and driver modes are available", "INVALID_ROLE");
    }
    const { db, usersTable, driverQueueTable, ordersTable } = await this.database();
    return db.transaction(async tx => {
      // Offer operations lock order -> queue -> users. Never acquire a queue
      // or order lock after the user lock in this operation.
      const [queued] = await tx.select({ id: driverQueueTable.driverId }).from(driverQueueTable)
        .where(eq(driverQueueTable.driverId, userId)).for("update").limit(1);
      const [userRow] = await tx.select().from(usersTable)
        .where(eq(usersTable.id, userId)).for("update").limit(1);
      if (!userRow) throw new AppError(401, "Account is not available", "UNAUTHORIZED");
      const user = asUser(userRow as unknown as Record<string, unknown>);
      if (expectedSessionVersion !== undefined && user.sessionVersion !== expectedSessionVersion) {
        throw new AppError(401, "Session is no longer valid", "UNAUTHORIZED");
      }
      if (user.role === "admin" || user.roles.includes("admin")) {
        throw new AppError(403, "Admin accounts cannot switch modes", "ADMIN_ROLE_FORBIDDEN");
      }
      // If a concurrent join inserted a previously absent queue row and held
      // the user SHARE lock first, it has committed before this UPDATE lock.
      // Re-read without a queue lock; a join that lost the user lock must
      // recheck the role/session before it can commit its inserted queue row.
      const [newQueue] = queued ? [queued] : await tx.select({ id: driverQueueTable.driverId }).from(driverQueueTable)
        .where(eq(driverQueueTable.driverId, userId)).limit(1);
      const [activeOrder] = await tx.select({ id: ordersTable.id }).from(ordersTable).where(and(
        sql`${ordersTable.status} NOT IN ('completed', 'cancelled')`,
        or(eq(ordersTable.passengerId, userId), eq(ordersTable.driverId, userId), eq(ordersTable.offeredDriverId, userId)),
      )).limit(1);
      if (newQueue || activeOrder) {
        throw new AppError(409, "Finish active orders and leave the driver queue before switching modes", "ROLE_BUSY");
      }
      const roles = user.roles.includes(nextRole) ? user.roles : [...user.roles, nextRole];
      const [updated] = await tx.update(usersTable).set({
        role: nextRole,
        roles,
        sessionVersion: sql`${usersTable.sessionVersion} + 1`,
        ...(nextRole === "driver" && !user.roles.includes("driver") ? { driverApprovalStatus: "pending" } : {}),
      }).where(eq(usersTable.id, userId)).returning();
      return asUser(updated as unknown as Record<string, unknown>);
    });
  }

  async setDriverRouteChoice(userId: string, input: DriverRouteChoiceInput | null, expectedSessionVersion: number): Promise<DriverRouteChoice | null> {
    const value = input === null ? null : validateDriverRouteChoiceInput(input);
    const { db, usersTable, driverQueueTable, ordersTable, routesTable } = await this.database();
    return db.transaction(async tx => {
      // Offer/lifecycle operations acquire queue locks before user locks.
      // Never wait for a queue or order lock after locking this user.
      const [queued] = await tx.select({ id: driverQueueTable.driverId }).from(driverQueueTable)
        .where(eq(driverQueueTable.driverId, userId)).for("update").limit(1);
      const [userRow] = await tx.select().from(usersTable)
        .where(eq(usersTable.id, userId)).for("update").limit(1);
      if (!userRow || userRow.sessionVersion !== expectedSessionVersion) {
        throw new AppError(401, "Session is no longer valid", "UNAUTHORIZED");
      }
      if (userRow.role !== "driver") throw new AppError(403, "driver mode is required", "FORBIDDEN");
      if (REQUIRE_DRIVER_APPROVAL && userRow.driverApprovalStatus !== "approved") {
        throw new AppError(403, "Driver approval is required", "DRIVER_APPROVAL_REQUIRED");
      }
      // A join that acquired the user SHARE lock first has committed by now.
      // A join still waiting for it must validate the choice before committing.
      const [newQueue] = queued ? [queued] : await tx.select({ id: driverQueueTable.driverId }).from(driverQueueTable)
        .where(eq(driverQueueTable.driverId, userId)).limit(1);
      const [activeOrder] = await tx.select({ id: ordersTable.id }).from(ordersTable).where(and(
        sql`${ordersTable.status} NOT IN ('completed', 'cancelled')`,
        or(eq(ordersTable.passengerId, userId), eq(ordersTable.driverId, userId), eq(ordersTable.offeredDriverId, userId)),
      )).limit(1);
      if (newQueue || activeOrder) {
        throw new AppError(409, "Finish active orders and leave the queue before changing the planned route", "DRIVER_ROUTE_BUSY");
      }
      let choice: DriverRouteChoice | null = null;
      if (value !== null) {
        const [routeRow] = await tx.select().from(routesTable)
          .where(eq(routesTable.id, value.routeId)).for("share").limit(1);
        const route = routeRow ? asRoute(routeRow as unknown as Record<string, unknown>) : undefined;
        assertDriverRouteChoiceRoute(route, value.expectedUpdatedAt);
        choice = { routeId: route.id, direction: value.direction, routeUpdatedAt: route.updatedAt };
      }
      await tx.update(usersTable).set({
        driverRouteChoice: choice as unknown as Record<string, unknown> | null,
      }).where(eq(usersTable.id, userId));
      return choice ? structuredClone(choice) : null;
    });
  }

  async consumeOtp(phoneNumber: string, code: string): Promise<OtpChallenge | undefined> {
    const { db, otpChallengesTable } = await this.database();
    const [row] = await db.delete(otpChallengesTable).where(and(
      eq(otpChallengesTable.phoneNumber, phoneNumber),
      eq(otpChallengesTable.code, otpDigest(code)),
      gt(otpChallengesTable.expiresAt, Date.now()),
    )).returning();
    return row ? {
      phoneNumber: row.phoneNumber,
      code,
      role: row.role as UserRole,
      locale: row.locale as Locale,
      fullName: row.fullName ?? undefined,
      expiresAt: Number(row.expiresAt),
    } : undefined;
  }

  async getQueueEntry(driverId: string): Promise<QueueEntry | undefined> {
    const { db, driverQueueTable } = await this.database();
    const [row] = await db.select().from(driverQueueTable).where(eq(driverQueueTable.driverId, driverId)).limit(1);
    return row ? asQueueEntry(row as unknown as Record<string, unknown>) : undefined;
  }

  async removeDriverFromFifo(driverId: string): Promise<QueueEntry | undefined> {
    return this.updateQueueEntry(driverId, { inFifo: false });
  }

  async returnDriverToFifo(driverId: string): Promise<QueueEntry | undefined> {
    return this.updateQueueEntry(driverId, { inFifo: true });
  }

  async joinQueue(entry: QueueEntry, expectedSessionVersion?: number, selection?: DriverRouteChoiceInput): Promise<QueueEntry> {
    if (entry.routeContext) throw new AppError(400, "Queue context is server-owned", "VALIDATION_ERROR");
    const { db, driverQueueTable, usersTable, routesTable } = await this.database();
    const initial = joinQueueEntry(entry);
    return db.transaction(async tx => {
      // Lock (or insert) the queue row before the user SHARE lock. A failed
      // role/session check rolls back the inserted row and seat updates.
      const [row] = await tx.insert(driverQueueTable).values({
        driverId: initial.driverId,
        ...queueValues(initial),
      }).onConflictDoUpdate({
        target: driverQueueTable.driverId,
        // PostgreSQL evaluates this condition on the locked conflicting row.
        // A stale controller snapshot cannot overwrite a newly accepted order.
        setWhere: and(
          eq(driverQueueTable.inFifo, true),
          isNull(driverQueueTable.currentOrderId),
          isNull(driverQueueTable.pendingOfferOrderId),
          sql`${driverQueueTable.activeOrderIds} = '[]'::jsonb`,
          selection ? sql`${driverQueueTable.routeContext}->>'routeId' = ${selection.routeId} AND ${driverQueueTable.routeContext}->>'direction' = ${selection.direction} AND ${driverQueueTable.routeContext}->>'routeUpdatedAt' = ${selection.expectedUpdatedAt}` : isNull(driverQueueTable.routeContext),
        ),
        set: {
          availableSeats: sql`CASE WHEN ${driverQueueTable.routeContext} IS NULL THEN ${entry.availableSeats} ELSE ${driverQueueTable.availableSeats} END`,
          lastLocation: entry.lastLocation as unknown as Record<string, unknown>,
        },
      }).returning();
      if (!row) {
        throw new AppError(409, "Driver cannot rejoin while an order or route is active", "QUEUE_BUSY");
      }
      const [user] = await tx.select().from(usersTable)
        .where(eq(usersTable.id, entry.driverId)).for("share").limit(1);
      if (!user || (expectedSessionVersion !== undefined && user.sessionVersion !== expectedSessionVersion)) {
        throw new AppError(401, "Session is no longer valid", "UNAUTHORIZED");
      }
      if (user.role !== "driver") throw new AppError(403, "driver mode is required", "FORBIDDEN");
      if (user.driverRouteChoice && REQUIRE_DRIVER_APPROVAL && user.driverApprovalStatus !== "approved") {
        throw new AppError(403, "Driver approval is required", "DRIVER_NOT_APPROVED");
      }
      const choice = user.driverRouteChoice as DriverRouteChoice | null;
      const [routeRow] = choice ? await tx.select().from(routesTable).where(eq(routesTable.id, choice.routeId)).for("share").limit(1) : [];
      const routeContext = resolveRouteQueue(choice ?? undefined,
        routeRow ? asRoute(routeRow as unknown as Record<string, unknown>) : undefined, selection, entry.lastLocation);
      const current = asQueueEntry(row as unknown as Record<string, unknown>);
      // A new row has no context until this transaction establishes the live choice.
      if (current.routeContext && (!sameQueueLane(current.routeContext, routeContext) || current.routeContext.routeUpdatedAt !== routeContext?.routeUpdatedAt)) {
        throw new AppError(409, "Leave the previous queue before joining another", "QUEUE_BUSY");
      }
      const [saved] = await tx.update(driverQueueTable).set({ routeContext: routeContext as unknown as Record<string, unknown> ?? null })
        .where(eq(driverQueueTable.driverId, entry.driverId)).returning();
      return asQueueEntry(saved! as unknown as Record<string, unknown>);
    });
  }

  async updateQueueEntry(driverId: string, patch: Partial<QueueEntry>): Promise<QueueEntry | undefined> {
    const { db, driverQueueTable } = await this.database();
    const values: {
      joinedAt?: number;
      status?: QueueEntry["status"];
      availableSeats?: number;
      lastLocation?: Record<string, unknown>;
      priorityLock?: boolean;
      inFifo?: boolean;
      activeOrderIds?: string[];
      currentOrderId?: string | null;
      pendingOfferOrderId?: string | null;
      seatLockExpiresAt?: number | null;
    } = {};
    if (patch.joinedAt !== undefined) values.joinedAt = patch.joinedAt;
    if (patch.status !== undefined) values.status = patch.status;
    if (patch.availableSeats !== undefined) values.availableSeats = patch.availableSeats;
    if (patch.lastLocation !== undefined) values.lastLocation = patch.lastLocation as unknown as Record<string, unknown>;
    if (patch.priorityLock !== undefined) values.priorityLock = patch.priorityLock;
    if (patch.inFifo !== undefined) values.inFifo = patch.inFifo;
    if (patch.activeOrderIds !== undefined) values.activeOrderIds = patch.activeOrderIds;
    if ("currentOrderId" in patch) values.currentOrderId = patch.currentOrderId ?? null;
    if ("pendingOfferOrderId" in patch) values.pendingOfferOrderId = patch.pendingOfferOrderId ?? null;
    if ("seatLockExpiresAt" in patch) values.seatLockExpiresAt = patch.seatLockExpiresAt ?? null;
    return db.transaction(async tx => {
      const [currentRow] = await tx.select().from(driverQueueTable)
        .where(eq(driverQueueTable.driverId, driverId)).for("update").limit(1);
      if (!currentRow) return undefined;
      const current = asQueueEntry(currentRow as unknown as Record<string, unknown>);
      assertQueueOfferPatch(current, patch);
      if ("routeContext" in patch) throw new AppError(409, "Queue context cannot be changed", "QUEUE_BUSY");
      if (current.routeContext && patch.lastLocation) assertRouteQueueTelemetry(current, patch.lastLocation);
      const [row] = await tx.update(driverQueueTable).set(values)
        .where(eq(driverQueueTable.driverId, driverId)).returning();
      return row ? asQueueEntry(row as unknown as Record<string, unknown>) : undefined;
    });
  }

  async leaveQueue(driverId: string): Promise<void> {
    const { db, driverQueueTable } = await this.database();
    await db.transaction(async tx => {
      const [row] = await tx.select().from(driverQueueTable)
        .where(eq(driverQueueTable.driverId, driverId)).for("update").limit(1);
      if (!row) return;
      const entry = asQueueEntry(row as unknown as Record<string, unknown>);
      if (hasActiveOrders(entry) || entry.pendingOfferOrderId) {
        throw new AppError(409, "Driver cannot leave the queue while an order is active", "ACTIVE_ORDER");
      }
      await tx.delete(driverQueueTable).where(eq(driverQueueTable.driverId, driverId));
    });
  }

  async getQueue(): Promise<QueueEntry[]> {
    const { db, driverQueueTable } = await this.database();
    const rows = await db.select().from(driverQueueTable).where(and(
      eq(driverQueueTable.inFifo, true),
      or(isNull(driverQueueTable.seatLockExpiresAt), gt(driverQueueTable.seatLockExpiresAt, Date.now())),
    )).orderBy(desc(driverQueueTable.priorityLock), asc(driverQueueTable.joinedAt), asc(driverQueueTable.driverId));
    return rows.map((row) => asQueueEntry(row as unknown as Record<string, unknown>)).sort(compareOfferDrivers);
  }

  async getQueuePosition(driverId: string): Promise<number | null> {
    return (await this.queueSnapshot()).find(entry => entry.driverId === driverId)?.position ?? null;
  }

  async getFirstEligibleDriver(seats: number): Promise<QueueEntry | undefined> {
    const { db, driverQueueTable } = await this.database();
    const rows = await db.select().from(driverQueueTable).where(and(
      eq(driverQueueTable.status, "in_transit"),
      isNull(driverQueueTable.pendingOfferOrderId),
    )).orderBy(desc(driverQueueTable.priorityLock), asc(driverQueueTable.joinedAt), asc(driverQueueTable.driverId));
    const entry = rows.map((row) => asQueueEntry(row as unknown as Record<string, unknown>)).find((candidate) =>
      !candidate.routeContext &&
      candidate.availableSeats >= seats &&
      Boolean(candidate.currentOrderId || (candidate.activeOrderIds && candidate.activeOrderIds.length > 0)),
    );
    return entry;
  }

  async getOrderAvailability(pickupPoint: PickupPoint, seats: number): Promise<{ available: boolean; eligibleDriverCount: number }> {
    assertLegacyOrderInput({ pickupPoint });
    const { db, driverQueueTable, usersTable } = await this.database();
    // Availability is a read-only snapshot. Creation repeats this decision
    // under locks so concurrent passengers cannot consume the same offer slot.
    const rows = await db.select({ queue: driverQueueTable }).from(driverQueueTable)
      .innerJoin(usersTable, eq(usersTable.id, driverQueueTable.driverId)).where(and(
        isNull(driverQueueTable.pendingOfferOrderId),
        pickupPoint === "D" ? eq(driverQueueTable.status, "in_transit") : eq(driverQueueTable.inFifo, true),
        eq(usersTable.role, "driver"),
        REQUIRE_DRIVER_APPROVAL ? eq(usersTable.driverApprovalStatus, "approved") : undefined,
      ));
    const eligibleDriverCount = orderedOfferCandidates(
      { pickupPoint, seats, attemptedDriverIds: [] },
      rows.map(row => asQueueEntry(row.queue as unknown as Record<string, unknown>)),
      Date.now(),
    ).length;
    return { available: eligibleDriverCount > 0, eligibleDriverCount };
  }

  async getRouteOrderAvailability(selection: DriverRouteChoiceInput, seats: number): Promise<{ available: boolean; eligibleDriverCount: number }> {
    const choice = validateDriverRouteChoiceInput(selection);
    seats = boundedInteger(seats, "seats", 1, 8);
    const { db, driverQueueTable, usersTable, routesTable } = await this.database();
    return db.transaction(async tx => {
      // No queue/user row is locked by this advisory read, so taking the route
      // SHARE lock here cannot invert the mutation order queue -> user -> route.
      const [routeRow] = await tx.select().from(routesTable)
        .where(eq(routesTable.id, choice.routeId)).for("share").limit(1);
      const route = routeRow ? asRoute(routeRow as unknown as Record<string, unknown>) : undefined;
      const details = buildRouteOrder(route, choice);
      const rows = await tx.select({ queue: driverQueueTable }).from(driverQueueTable)
        .innerJoin(usersTable, eq(usersTable.id, driverQueueTable.driverId)).where(and(
          isNull(driverQueueTable.pendingOfferOrderId),
          eq(driverQueueTable.inFifo, true), eq(driverQueueTable.status, "searching"),
          sql`${driverQueueTable.routeContext}->>'routeId' = ${choice.routeId} AND ${driverQueueTable.routeContext}->>'direction' = ${choice.direction} AND ${driverQueueTable.routeContext}->>'routeUpdatedAt' = ${choice.expectedUpdatedAt} AND ${driverQueueTable.routeContext}->>'pitak' = ${choice.direction === "a_to_b" ? "A" : "B"}`,
          eq(usersTable.role, "driver"),
          REQUIRE_DRIVER_APPROVAL ? eq(usersTable.driverApprovalStatus, "approved") : undefined,
        ));
      const eligibleDriverCount = orderedOfferCandidates(
        { ...details, seats }, rows.map(row => asQueueEntry(row.queue as unknown as Record<string, unknown>)), Date.now(), route,
      ).length;
      return { available: eligibleDriverCount > 0, eligibleDriverCount };
    });
  }

  async createOrderWithOffer(input: Omit<Order, "id" | "createdAt" | "updatedAt">, expectedSessionVersion?: number): Promise<Order | undefined> {
    assertLegacyOrderInput(input);
    return this.reserveNewOrder(input, expectedSessionVersion);
  }

  async createRouteOrderWithOffer(input: RouteOrderInput, selection: DriverRouteChoiceInput, expectedSessionVersion?: number): Promise<Order | undefined> {
    const choice = validateDriverRouteChoiceInput(selection);
    if (!input.pickupLocation) throw new AppError(422, "Pickup location is required", "OUTSIDE_PICKUP_GEOFENCE");
    return this.reserveNewOrder({
      passengerId: input.passengerId, passengerPhone: input.passengerPhone,
      pickupLocation: structuredClone(input.pickupLocation), seats: boundedInteger(input.seats, "seats", 1, 8),
    }, expectedSessionVersion, choice);
  }

  private async reserveNewOrder(
    input: Omit<Order, "id" | "createdAt" | "updatedAt"> | RouteOrderInput,
    expectedSessionVersion?: number,
    selection?: DriverRouteChoiceInput,
  ): Promise<Order | undefined> {
    const { db, driverQueueTable, usersTable, ordersTable, routesTable } = await this.database();
    const legacyInput = input as Omit<Order, "id" | "createdAt" | "updatedAt">;
    return db.transaction(async tx => {
      // This order does not exist yet. Locking queue rows before inserting its
      // new UUID cannot acquire or wait on another existing order row.
      const queueRows = await tx.select().from(driverQueueTable).where(and(
        isNull(driverQueueTable.pendingOfferOrderId),
        selection
          ? and(eq(driverQueueTable.inFifo, true), eq(driverQueueTable.status, "searching"),
            sql`${driverQueueTable.routeContext}->>'routeId' = ${selection.routeId} AND ${driverQueueTable.routeContext}->>'direction' = ${selection.direction} AND ${driverQueueTable.routeContext}->>'routeUpdatedAt' = ${selection.expectedUpdatedAt} AND ${driverQueueTable.routeContext}->>'pitak' = ${selection.direction === "a_to_b" ? "A" : "B"}`)
          : and(isNull(driverQueueTable.routeContext), legacyInput.pickupPoint === "D"
            ? eq(driverQueueTable.status, "in_transit") : eq(driverQueueTable.inFifo, true)),
      )).orderBy(asc(driverQueueTable.driverId)).for("update");
      const entries = queueRows.map(row => asQueueEntry(row as unknown as Record<string, unknown>));
      // Hold the passenger's mode/session through the insert, together with
      // driver eligibility. All queue locks precede all user locks.
      const users = await tx.select().from(usersTable).where(
        inArray(usersTable.id, [...new Set([input.passengerId, ...entries.map(entry => entry.driverId)])]),
      ).orderBy(asc(usersTable.id)).for("share");
      const passenger = users.find(user => user.id === input.passengerId);
      if (!passenger || (expectedSessionVersion !== undefined && passenger.sessionVersion !== expectedSessionVersion)) {
        throw new AppError(401, "Session is no longer valid", "UNAUTHORIZED");
      }
      if (passenger.role !== "passenger") throw new AppError(403, "passenger mode is required", "FORBIDDEN");
      let liveRoute: RouteDefinition | undefined;
      let orderInput = legacyInput;
      if (selection) {
        // Catalog writers own only the route. All existing queue/user locks
        // precede this route SHARE lock, held through fare/offer persistence.
        const [routeRow] = await tx.select().from(routesTable)
          .where(eq(routesTable.id, selection.routeId)).for("share").limit(1);
        liveRoute = routeRow ? asRoute(routeRow as unknown as Record<string, unknown>) : undefined;
        orderInput = { ...input, ...buildRouteOrder(liveRoute, selection, input.pickupLocation), status: "searching" };
      }
      const approvedIds = new Set(users.filter(user => user.role === "driver" &&
        (!REQUIRE_DRIVER_APPROVAL || user.driverApprovalStatus === "approved")).map(user => user.id));
      const now = Date.now();
      const candidate = orderedOfferCandidates(
        { ...orderInput, attemptedDriverIds: [] },
        entries.filter(entry => approvedIds.has(entry.driverId)),
        now,
        liveRoute,
      )[0];
      if (!candidate) return undefined;

      const timestamp = new Date(now).toISOString();
      const order: Order = {
        ...orderInput,
        id: randomUUID(),
        status: "searching",
        driverId: undefined,
        offeredDriverId: candidate.driverId,
        offerExpiresAt: now + OFFER_TIMEOUT_MS,
        seatLockExpiresAt: undefined,
        attemptedDriverIds: [candidate.driverId],
        cancelledBy: undefined,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      await tx.update(driverQueueTable).set(queueValues(reserveQueueOffer(candidate, order)))
        .where(eq(driverQueueTable.driverId, candidate.driverId));
      const [row] = await tx.insert(ordersTable).values({
        id: order.id,
        passengerId: order.passengerId,
        createdAt: order.createdAt,
        ...orderValues(order),
      }).returning();
      return asOrder(row as unknown as Record<string, unknown>);
    });
  }

  async createOrder(input: Omit<Order, "id" | "createdAt" | "updatedAt">, expectedSessionVersion?: number): Promise<Order> {
    assertLegacyOrderInput(input);
    const { db, ordersTable, usersTable } = await this.database();
    return db.transaction(async tx => {
      // The inserted UUID is new; this acquires no existing order/queue lock
      // after the user SHARE lock and keeps its role valid through commit.
      const [passenger] = await tx.select().from(usersTable)
        .where(eq(usersTable.id, input.passengerId)).for("share").limit(1);
      if (!passenger || (expectedSessionVersion !== undefined && passenger.sessionVersion !== expectedSessionVersion)) {
        throw new AppError(401, "Session is no longer valid", "UNAUTHORIZED");
      }
      if (passenger.role !== "passenger") throw new AppError(403, "passenger mode is required", "FORBIDDEN");
      const now = new Date().toISOString();
      const order: Order = { ...input, id: randomUUID(), createdAt: now, updatedAt: now };
      const [row] = await tx.insert(ordersTable).values({
        id: order.id,
        passengerId: order.passengerId,
        driverId: order.driverId ?? null,
        offeredDriverId: order.offeredDriverId ?? null,
        offerExpiresAt: order.offerExpiresAt ?? null,
        status: order.status,
        createdAt: order.createdAt,
        updatedAt: order.updatedAt,
        payload: order as unknown as Record<string, unknown>,
      }).returning();
      return asOrder(row as unknown as Record<string, unknown>);
    });
  }

  async getOrder(orderId: string): Promise<Order | undefined> {
    const { db, ordersTable } = await this.database();
    const [row] = await db.select().from(ordersTable).where(eq(ordersTable.id, orderId)).limit(1);
    return row ? asOrder(row as unknown as Record<string, unknown>) : undefined;
  }

  async updateOrder(orderId: string, patch: Partial<Order>): Promise<Order | undefined> {
    const { db, ordersTable } = await this.database();
    return db.transaction(async (tx) => {
      const [currentRow] = await tx.select().from(ordersTable).where(eq(ordersTable.id, orderId))
        .for("update").limit(1);
      if (!currentRow) return undefined;
      const current = asOrder(currentRow as unknown as Record<string, unknown>);
      assertOrderOfferPatch(current, patch);
      const updated: Order = { ...current, ...patch, id: current.id, updatedAt: new Date().toISOString() };
      const [row] = await tx.update(ordersTable).set({
        driverId: updated.driverId ?? null,
        offeredDriverId: updated.offeredDriverId ?? null,
        offerExpiresAt: updated.offerExpiresAt ?? null,
        status: updated.status,
        updatedAt: updated.updatedAt,
        payload: updated as unknown as Record<string, unknown>,
      }).where(eq(ordersTable.id, orderId)).returning();
      return row ? asOrder(row as unknown as Record<string, unknown>) : undefined;
    });
  }

  async dispatchOrderOffer(orderId: string, now?: number): Promise<OrderOfferChange | undefined> {
    return this.advanceOrderOffer(orderId, now);
  }

  async rejectOrderOffer(orderId: string, driverId: string, now?: number, expectedSessionVersion?: number): Promise<OrderOfferChange | undefined> {
    return this.advanceOrderOffer(orderId, now, driverId, expectedSessionVersion);
  }

  /** Release and select the next driver while holding one order and its candidate queue rows. */
  private async advanceOrderOffer(
    orderId: string,
    now?: number,
    rejectingDriverId?: string,
    expectedSessionVersion?: number,
  ): Promise<OrderOfferChange | undefined> {
    const { db, ordersTable, driverQueueTable, usersTable, routesTable } = await this.database();
    return db.transaction(async tx => {
      const [orderRow] = await tx.select().from(ordersTable)
        .where(eq(ordersTable.id, orderId)).for("update").limit(1);
      if (!orderRow) return undefined;
      const order = asOrder(orderRow as unknown as Record<string, unknown>);
      if (order.status !== "searching" || order.driverId) return undefined;

      // Every offer operation locks queue rows only once, in driver-ID order.
      // A competing order can reserve a candidate while this query waits;
      // PostgreSQL rechecks the predicate on that row after the lock is won.
      const queueRows = await tx.select().from(driverQueueTable).where(or(
        and(
          isNull(driverQueueTable.pendingOfferOrderId),
          order.routeContext
            ? and(eq(driverQueueTable.inFifo, true), eq(driverQueueTable.status, "searching"),
              sql`${driverQueueTable.routeContext}->>'routeId' = ${order.routeContext.routeId} AND ${driverQueueTable.routeContext}->>'direction' = ${order.routeContext.direction} AND ${driverQueueTable.routeContext}->>'routeUpdatedAt' = ${order.routeContext.routeUpdatedAt} AND ${driverQueueTable.routeContext}->>'pitak' = ${order.routeContext.pitak}`)
            : and(isNull(driverQueueTable.routeContext), order.pickupPoint === "D"
              ? eq(driverQueueTable.status, "in_transit") : eq(driverQueueTable.inFifo, true)),
        ),
        order.offeredDriverId ? eq(driverQueueTable.driverId, order.offeredDriverId) : undefined,
      )).orderBy(asc(driverQueueTable.driverId)).for("update");
      const entries = queueRows.map(row => asQueueEntry(row as unknown as Record<string, unknown>));
      const previousEntry = entries.find(entry => entry.driverId === order.offeredDriverId);
      // A revoked driver may still have a queue row. Hold approved user rows
      // through commit so a revocation cannot race this reservation decision.
      const liveDrivers = entries.length
        ? await tx.select().from(usersTable).where(
          inArray(usersTable.id, entries.map(entry => entry.driverId)),
        ).orderBy(asc(usersTable.id)).for("share")
        : [];
      const approvedIds = new Set(liveDrivers.filter(driver => driver.role === "driver" &&
        (!REQUIRE_DRIVER_APPROVAL || driver.driverApprovalStatus === "approved")).map(driver => driver.id));
      if (rejectingDriverId !== undefined && expectedSessionVersion !== undefined) {
        const actor = liveDrivers.find(driver => driver.id === rejectingDriverId);
        if (!actor || actor.sessionVersion !== expectedSessionVersion) {
          throw new AppError(401, "Session is no longer valid", "UNAUTHORIZED");
        }
        if (!approvedIds.has(rejectingDriverId)) return undefined;
      }
      let liveRoute: RouteDefinition | undefined;
      if (order.routeContext) {
        const [routeRow] = await tx.select().from(routesTable)
          .where(eq(routesTable.id, order.routeContext.routeId)).for("share").limit(1);
        liveRoute = routeRow ? asRoute(routeRow as unknown as Record<string, unknown>) : undefined;
      }
      const offerTime = now ?? Date.now();
      const liveOffer = hasLiveOrderOffer(order, offerTime);
      if (rejectingDriverId !== undefined) {
        if (!liveOffer || order.offeredDriverId !== rejectingDriverId ||
          previousEntry?.pendingOfferOrderId !== order.id) return undefined;
      } else if (liveOffer && approvedIds.has(order.offeredDriverId!) &&
        queueOwnsEligibleOffer(previousEntry, order, offerTime, liveRoute)) {
        return undefined;
      }

      const previousDriverId = order.offeredDriverId;
      if (previousEntry) {
        const released = releaseQueueOffer(previousEntry, order);
        if (released !== previousEntry) {
          await tx.update(driverQueueTable).set(queueValues(released))
            .where(eq(driverQueueTable.driverId, previousEntry.driverId));
          entries[entries.indexOf(previousEntry)] = released;
        }
      }
      const attemptedDriverIds = [...new Set([
        ...(order.attemptedDriverIds ?? []),
        ...(previousDriverId ? [previousDriverId] : []),
      ])];
      const candidate = orderedOfferCandidates({ ...order, attemptedDriverIds },
        entries.filter(entry => approvedIds.has(entry.driverId)),
        offerTime, liveRoute)[0];
      // Waiting with no available candidate is a read-only result. Notification
      // callers receive changes only when an actual lifecycle update commits.
      if (!candidate && !previousDriverId && order.offerExpiresAt === undefined) return undefined;

      const updated: Order = {
        ...order,
        offeredDriverId: candidate?.driverId,
        offerExpiresAt: candidate ? offerTime + OFFER_TIMEOUT_MS : undefined,
        attemptedDriverIds: candidate ? [...attemptedDriverIds, candidate.driverId] : attemptedDriverIds,
        updatedAt: new Date(offerTime).toISOString(),
      };
      if (candidate) {
        await tx.update(driverQueueTable).set(queueValues(reserveQueueOffer(candidate, updated)))
          .where(eq(driverQueueTable.driverId, candidate.driverId));
      }
      await tx.update(ordersTable).set(orderValues(updated)).where(eq(ordersTable.id, orderId));
      return { order: updated, ...(previousDriverId ? { previousDriverId } : {}) };
    });
  }

  async acceptOrderOffer(orderId: string, driverId: string, now?: number, expectedSessionVersion?: number): Promise<Order | undefined> {
    const { db, ordersTable, driverQueueTable, usersTable, routesTable } = await this.database();
    return db.transaction(async tx => {
      const [orderRow] = await tx.select().from(ordersTable)
        .where(eq(ordersTable.id, orderId)).for("update").limit(1);
      if (!orderRow) return undefined;
      const order = asOrder(orderRow as unknown as Record<string, unknown>);
      if (order.offeredDriverId !== driverId || order.status !== "searching" || order.driverId) return undefined;
      const [queueRow] = await tx.select().from(driverQueueTable)
        .where(eq(driverQueueTable.driverId, driverId)).for("update").limit(1);
      const entry = queueRow ? asQueueEntry(queueRow as unknown as Record<string, unknown>) : undefined;
      const [driver] = await tx.select().from(usersTable)
        .where(eq(usersTable.id, driverId)).for("share").limit(1);
      if (expectedSessionVersion !== undefined && (!driver || driver.sessionVersion !== expectedSessionVersion)) {
        throw new AppError(401, "Session is no longer valid", "UNAUTHORIZED");
      }
      if (!driver || driver.role !== "driver" || (REQUIRE_DRIVER_APPROVAL && driver.driverApprovalStatus !== "approved")) return undefined;
      let liveRoute: RouteDefinition | undefined;
      if (order.routeContext) {
        const [routeRow] = await tx.select().from(routesTable)
          .where(eq(routesTable.id, order.routeContext.routeId)).for("share").limit(1);
        liveRoute = routeRow ? asRoute(routeRow as unknown as Record<string, unknown>) : undefined;
      }
      const offerTime = now ?? Date.now();
      if (!hasLiveOrderOffer(order, offerTime) || !queueOwnsEligibleOffer(entry, order, offerTime, liveRoute)) return undefined;

      const updated: Order = {
        ...order,
        status: order.pickupPoint === "D" ? "in_transit" : "en_route_to_c",
        driverId,
        offeredDriverId: driverId,
        offerExpiresAt: undefined,
        seatLockExpiresAt: order.pickupPoint === "D" ? undefined : offerTime + SEAT_LOCK_TTL_MS,
        updatedAt: new Date(offerTime).toISOString(),
      };
      await tx.update(driverQueueTable).set(queueValues(acceptQueueOffer(entry!, updated)))
        .where(eq(driverQueueTable.driverId, driverId));
      await tx.update(ordersTable).set(orderValues(updated)).where(eq(ordersTable.id, orderId));
      return updated;
    });
  }

  async processOrderOffers(now?: number): Promise<OrderOfferChange[]> {
    const { db, ordersTable } = await this.database();
    const scanTime = now ?? Date.now();
    // The scan owns no row locks. Each order is re-read under its own lock,
    // preventing cross-order lock cycles and stale timeout decisions.
    const rows = await db.select({
      id: ordersTable.id,
      offeredDriverId: ordersTable.offeredDriverId,
      offerExpiresAt: ordersTable.offerExpiresAt,
    }).from(ordersTable).where(and(
      eq(ordersTable.status, "searching"),
      isNull(ordersTable.driverId),
    )).orderBy(asc(ordersTable.createdAt), asc(ordersTable.id));
    const expired = rows.filter(row => row.offeredDriverId && (row.offerExpiresAt === null || row.offerExpiresAt <= scanTime));
    const waiting = rows.filter(row => !row.offeredDriverId);
    const live = rows.filter(row => row.offeredDriverId && row.offerExpiresAt !== null && row.offerExpiresAt > scanTime);
    const changes: OrderOfferChange[] = [];
    for (const row of [...expired, ...waiting, ...live]) {
      const change = await this.dispatchOrderOffer(row.id, now);
      if (change) changes.push(change);
    }
    return changes;
  }

  async transitionOrder(
    orderId: string,
    actorId: string,
    nextStatus: OrderStatus,
    expectedStatus?: OrderStatus,
    expectedSessionVersion?: number,
  ): Promise<Order | undefined> {
    const { db, ordersTable, driverQueueTable, usersTable } = await this.database();
    return db.transaction(async (tx) => {
      // Every lifecycle operation acquires the order before any queue row.
      const [orderRow] = await tx.select().from(ordersTable).where(eq(ordersTable.id, orderId))
        .for("update").limit(1);
      if (!orderRow) return undefined;
      const order = asOrder(orderRow as unknown as Record<string, unknown>);
      if (!canTransitionOrder(order, actorId, nextStatus, expectedStatus)) return undefined;
      const queueDriverId = order.driverId ?? (nextStatus === "cancelled" ? order.offeredDriverId : undefined);
      let entry: QueueEntry | undefined;
      if (queueDriverId) {
        const [queueRow] = await tx.select().from(driverQueueTable)
          .where(eq(driverQueueTable.driverId, queueDriverId)).for("update").limit(1);
        entry = queueRow ? asQueueEntry(queueRow as unknown as Record<string, unknown>) : undefined;
      }
      if (expectedSessionVersion !== undefined) {
        // Acquire the actor only after the order and its queue, matching every
        // offer operation and preventing revocation from racing this transition.
        const [actor] = await tx.select().from(usersTable).where(eq(usersTable.id, actorId)).for("share").limit(1);
        if (!actor || actor.sessionVersion !== expectedSessionVersion) {
          throw new AppError(401, "Session is no longer valid", "UNAUTHORIZED");
        }
        const role = actorId === order.passengerId ? "passenger" : "driver";
        if (actor.role !== role) throw new AppError(403, `${role} mode is required`, "FORBIDDEN");
        if (role === "driver" && REQUIRE_DRIVER_APPROVAL && actor.driverApprovalStatus !== "approved") {
          throw new AppError(403, "Driver approval is required", "DRIVER_NOT_APPROVED");
        }
      }
      if (entry && queueDriverId) {
        const updatedEntry = order.driverId ? transitionQueueEntry(entry, order, nextStatus) : releaseQueueOffer(entry, order);
        await tx.update(driverQueueTable).set(queueValues(updatedEntry)).where(eq(driverQueueTable.driverId, queueDriverId));
      }
      const updated: Order = {
        ...order,
        status: nextStatus,
        ...(nextStatus === "cancelled" ? {
          cancelledBy: actorId,
          offerExpiresAt: undefined,
        } : {}),
        seatLockExpiresAt: nextStatus === "in_transit" || nextStatus === "completed" || nextStatus === "cancelled"
          ? undefined : order.seatLockExpiresAt,
        updatedAt: new Date().toISOString(),
      };
      await tx.update(ordersTable).set({
        driverId: updated.driverId ?? null,
        offeredDriverId: updated.offeredDriverId ?? null,
        offerExpiresAt: updated.offerExpiresAt ?? null,
        status: updated.status,
        updatedAt: updated.updatedAt,
        payload: updated as unknown as Record<string, unknown>,
      }).where(eq(ordersTable.id, orderId));
      return updated;
    });
  }

  async claimOrderForDriver(
    orderId: string,
    driverId: string,
    orderPatch: Partial<Order>,
    _queuePatch: Partial<QueueEntry>,
  ): Promise<Order | undefined> {
    const { db, ordersTable, driverQueueTable } = await this.database();
    return db.transaction(async (tx) => {
      const [orderRow] = await tx.select().from(ordersTable)
        .where(eq(ordersTable.id, orderId))
        .for("update")
        .limit(1);
      if (!orderRow) return undefined;
      const order = asOrder(orderRow as unknown as Record<string, unknown>);
      if (
        order.routeContext || order.pickupPoint === "A" || order.pickupPoint === "B" ||
        order.status !== "searching" ||
        order.offerExpiresAt !== undefined ||
        (order.driverId && order.driverId !== driverId) ||
        (order.offeredDriverId && order.offeredDriverId !== driverId)
      ) return undefined;

      // Lock the target and FIFO candidates once in a canonical order. Locking
      // the chosen driver first can deadlock with a claim for another driver.
      const eligibilityTime = Date.now();
      const queueRows = await tx.select().from(driverQueueTable).where(or(
        eq(driverQueueTable.driverId, driverId),
        and(
          eq(driverQueueTable.inFifo, true),
          or(isNull(driverQueueTable.seatLockExpiresAt), gt(driverQueueTable.seatLockExpiresAt, eligibilityTime)),
        ),
      )).orderBy(asc(driverQueueTable.driverId)).for("update");
      const queueRow = queueRows.find(row => row.driverId === driverId);
      if (!queueRow) return undefined;
      const entry = asQueueEntry(queueRow as unknown as Record<string, unknown>);
      if (entry.routeContext || entry.pendingOfferOrderId || entry.availableSeats < order.seats) return undefined;

      const now = Date.now();
      const fifo = queueRows.map(row => asQueueEntry(row as unknown as Record<string, unknown>))
        .filter(candidate => !candidate.routeContext && candidate.inFifo !== false &&
          (!candidate.seatLockExpiresAt || candidate.seatLockExpiresAt > now))
        .sort((a, b) => Number(b.priorityLock) - Number(a.priorityLock) || a.joinedAt - b.joinedAt);
      const firstFifoDriverId = fifo[0]?.driverId;
      const activePoolOffer =
        order.pickupPoint === "D" &&
        order.offeredDriverId === driverId &&
        entry.inFifo === false &&
        entry.status === "in_transit";
      if (!activePoolOffer && firstFifoDriverId !== driverId) return undefined;

      const expectedStatus = order.pickupPoint === "C" ? "en_route_to_c" : "in_transit";
      if (orderPatch.status !== undefined && orderPatch.status !== expectedStatus) return undefined;

      const updatedOrder: Order = {
        ...order,
        ...orderPatch,
        id: order.id,
        status: expectedStatus,
        driverId,
        offeredDriverId: driverId,
        updatedAt: new Date().toISOString(),
      };
      const updatedEntry = claimQueueEntry(entry, updatedOrder);
      await tx.update(ordersTable).set({
        driverId,
        offeredDriverId: driverId,
        status: updatedOrder.status,
        updatedAt: updatedOrder.updatedAt,
        payload: updatedOrder as unknown as Record<string, unknown>,
      }).where(eq(ordersTable.id, orderId));
      await tx.update(driverQueueTable).set(queueValues(updatedEntry)).where(eq(driverQueueTable.driverId, driverId));
      return updatedOrder;
    });
  }

  async listOrdersForUser(userId: string): Promise<Order[]> {
    const { db, ordersTable } = await this.database();
    const rows = await db.select().from(ordersTable).where(or(
      eq(ordersTable.passengerId, userId),
      eq(ordersTable.driverId, userId),
      and(
        eq(ordersTable.status, "searching"),
        eq(ordersTable.offeredDriverId, userId),
        gt(ordersTable.offerExpiresAt, Date.now()),
      ),
    )).orderBy(desc(ordersTable.createdAt));
    return rows.map((row) => asOrder(row as unknown as Record<string, unknown>));
  }

  async listOrders(): Promise<Order[]> {
    const { db, ordersTable } = await this.database();
    const rows = await db.select().from(ordersTable).orderBy(desc(ordersTable.createdAt));
    return rows.map((row) => asOrder(row as unknown as Record<string, unknown>));
  }

  async listUsers(role?: User["role"]): Promise<User[]> {
    const { db, usersTable } = await this.database();
    const rows = role
      ? await db.select().from(usersTable).where(sql`${usersTable.roles} ? ${role}`)
      : await db.select().from(usersTable);
    return rows.map((row) => asUser(row as unknown as Record<string, unknown>));
  }

  async setDriverApproval(userId: string, status: DriverApprovalStatus): Promise<User | undefined> {
    const { db, usersTable } = await this.database();
    const [row] = await db.update(usersTable).set({ driverApprovalStatus: status })
      .where(and(eq(usersTable.id, userId), sql`${usersTable.roles} ? 'driver'`)).returning();
    return row ? asUser(row as unknown as Record<string, unknown>) : undefined;
  }

  async listRoutes(): Promise<RouteDefinition[]> {
    const { db, routesTable } = await this.database();
    const rows = await db.select().from(routesTable).orderBy(asc(routesTable.name));
    return rows.map((row) => asRoute(row as unknown as Record<string, unknown>));
  }

  async getRoute(routeId: string): Promise<RouteDefinition | undefined> {
    const { db, routesTable } = await this.database();
    const [row] = await db.select().from(routesTable).where(eq(routesTable.id, routeId)).limit(1);
    return row ? asRoute(row as unknown as Record<string, unknown>) : undefined;
  }

  async updateRouteLayout(routeId: string, input: RouteLayoutInput): Promise<RouteDefinition | undefined> {
    return this.mutateRoute(routeId, (route) => ({ route: replaceRouteLayout(route, input) }));
  }

  async createRoute(input: { id: string; name: string; pricePerStopKzt: number; active: boolean }): Promise<RouteDefinition> {
    const { db, routesTable } = await this.database();
    const now = new Date().toISOString();
    const route: RouteDefinition = {
      ...input,
      currency: "KZT",
      stops: [],
      createdAt: now,
      updatedAt: now,
    };
    const [row] = await db.insert(routesTable).values({
      id: route.id,
      name: route.name,
      active: route.active,
      pricePerStopKzt: route.pricePerStopKzt,
      createdAt: route.createdAt,
      updatedAt: route.updatedAt,
      payload: route as unknown as Record<string, unknown>,
    }).onConflictDoNothing().returning();
    if (!row) throw new Error(`Route ${route.id} already exists`);
    return asRoute(row as unknown as Record<string, unknown>);
  }

  async updateRoute(routeId: string, patch: Partial<Pick<RouteDefinition, "name" | "pricePerStopKzt" | "active">>): Promise<RouteDefinition | undefined> {
    return this.mutateRoute(routeId, (route) => ({
      route: { ...route, ...patch, updatedAt: nextRouteUpdatedAt(route.updatedAt) },
    }));
  }

  async deleteRoute(routeId: string): Promise<boolean> {
    const { db, routesTable } = await this.database();
    return db.transaction(async tx => {
      const [row] = await tx.select({ id: routesTable.id }).from(routesTable)
        .where(eq(routesTable.id, routeId)).for("update").limit(1);
      if (!row) return false;
      await tx.delete(routesTable).where(eq(routesTable.id, routeId));
      return true;
    });
  }

  async addRouteStop(routeId: string, input: { code: string; name: string; sequence?: number; position?: number }): Promise<RouteStop | undefined> {
    return this.mutateRoute(routeId, (route) => {
      const changed = mutateRouteStop(route, { kind: "add", input });
      return changed?.stop ? { route: changed.route, result: changed.stop } : undefined;
    });
  }

  async updateRouteStop(routeId: string, stopId: string, patch: Partial<Pick<RouteStop, "code" | "name" | "sequence" | "position">>): Promise<RouteStop | undefined> {
    return this.mutateRoute(routeId, (route) => {
      const changed = mutateRouteStop(route, { kind: "update", stopId, patch });
      return changed?.stop ? { route: changed.route, result: changed.stop } : undefined;
    });
  }

  async deleteRouteStop(routeId: string, stopId: string): Promise<boolean> {
    return (await this.mutateRoute(routeId, (route) => {
      const changed = mutateRouteStop(route, { kind: "delete", stopId });
      return changed ? { route: changed.route, result: true } : undefined;
    })) ?? false;
  }

  /** Every catalog writer reads the current JSON payload under the same lock. */
  private async mutateRoute<T = RouteDefinition>(
    routeId: string,
    mutate: (route: RouteDefinition) => { route: RouteDefinition; result?: T } | undefined,
  ): Promise<T | undefined> {
    const { db, routesTable } = await this.database();
    return db.transaction(async tx => {
      const [current] = await tx.select().from(routesTable)
        .where(eq(routesTable.id, routeId)).for("update").limit(1);
      if (!current) return undefined;
      const changed = mutate(asRoute(current as unknown as Record<string, unknown>));
      if (!changed) return undefined;
      const { route } = changed;
      const [row] = await tx.update(routesTable).set({
        name: route.name,
        active: route.active,
        pricePerStopKzt: route.pricePerStopKzt,
        updatedAt: route.updatedAt,
        payload: route as unknown as Record<string, unknown>,
      }).where(eq(routesTable.id, routeId)).returning();
      return changed.result ?? asRoute(row as unknown as Record<string, unknown>) as T;
    });
  }

  async saveDeviceRegistration(userId: string, deviceToken: string, platform: DeviceRegistration["platform"]): Promise<DeviceRegistration> {
    const { db, deviceRegistrationsTable } = await this.database();
    const registration: DeviceRegistration = { userId, deviceToken, platform, createdAt: new Date().toISOString() };
    const [row] = await db.insert(deviceRegistrationsTable).values(registration)
      .onConflictDoUpdate({
        target: [deviceRegistrationsTable.userId, deviceRegistrationsTable.deviceToken],
        set: { platform, createdAt: registration.createdAt },
      }).returning();
    return row as DeviceRegistration;
  }

  async getDeviceRegistrations(userId: string): Promise<DeviceRegistration[]> {
    const { db, deviceRegistrationsTable } = await this.database();
    return await db.select().from(deviceRegistrationsTable).where(eq(deviceRegistrationsTable.userId, userId)) as DeviceRegistration[];
  }

  async clearExpiredSeatLocks(): Promise<void> {
    const { db, ordersTable, driverQueueTable } = await this.database();
    const now = Date.now();

    // Find candidates without holding locks for the whole scan. Each candidate
    // is re-read and locked in a transaction before any seats are restored.
    const candidates = await db.select({ id: ordersTable.id }).from(ordersTable)
      .where(eq(ordersTable.status, "en_route_to_c"));

    for (const candidate of candidates) {
      await db.transaction(async (tx) => {
        const [orderRow] = await tx.select().from(ordersTable)
          .where(and(
            eq(ordersTable.id, candidate.id),
            eq(ordersTable.status, "en_route_to_c"),
          ))
          .for("update")
          .limit(1);
        if (!orderRow) return;

        const order = asOrder(orderRow as unknown as Record<string, unknown>);
        if (!order.seatLockExpiresAt || order.seatLockExpiresAt > now) return;

        if (order.driverId) {
          const [queueRow] = await tx.select().from(driverQueueTable)
            .where(eq(driverQueueTable.driverId, order.driverId))
            .for("update")
            .limit(1);

          if (queueRow) {
            const entry = asQueueEntry(queueRow as unknown as Record<string, unknown>);
            await tx.update(driverQueueTable)
              .set(queueValues(releaseQueueEntry(entry, order)))
              .where(eq(driverQueueTable.driverId, order.driverId));
          }
        }

        const reopened: Order = {
          ...order,
          status: "searching",
          driverId: undefined,
          offeredDriverId: undefined,
          offerExpiresAt: undefined,
          seatLockExpiresAt: undefined,
          updatedAt: new Date().toISOString(),
        };
        await tx.update(ordersTable).set({
          driverId: null,
          offeredDriverId: null,
          offerExpiresAt: null,
          status: "searching",
          updatedAt: reopened.updatedAt,
          payload: reopened as unknown as Record<string, unknown>,
        }).where(eq(ordersTable.id, order.id));
      });
    }

    // Expired queue-only locks can be cleared independently. This cleanup does
    // not restore seats; seat restoration is handled only by the locked order
    // transaction above.
    await db.transaction(async tx => {
      // Dispatch locks candidate rows by driver ID. Queue-only cleanup must
      // acquire its rows in the same order before issuing a bulk update.
      const expiredRows = await tx.select({ driverId: driverQueueTable.driverId }).from(driverQueueTable)
        .where(lte(driverQueueTable.seatLockExpiresAt, now))
        .orderBy(asc(driverQueueTable.driverId)).for("update");
      if (expiredRows.length) {
        await tx.update(driverQueueTable).set({ seatLockExpiresAt: null })
          .where(inArray(driverQueueTable.driverId, expiredRows.map(row => row.driverId)));
      }
    });
  }

  async queueSnapshot(): Promise<Array<QueueEntry & { position: number }>> {
    return routeQueueSnapshot(await this.getQueue());
  }
}

