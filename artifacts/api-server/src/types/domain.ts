export type UserRole = "passenger" | "driver" | "admin";
export type Locale = "kk" | "uz" | "ru";
export type PickupPoint = "A" | "B" | "C" | "D";
export type OrderStatus =
  | "searching"
  | "en_route_to_c"
  | "arrived_at_c"
  | "boarded_waiting"
  | "in_transit"
  | "completed"
  | "cancelled";
export type DriverQueueStatus =
  | "searching"
  | "picking_up"
  | "en_route_to_c"
  | "arrived_at_c"
  | "in_transit";
export type DriverApprovalStatus = "pending" | "approved" | "rejected";

export interface Coordinates {
  lat: number;
  lng: number;
  timestamp: number;
  isMocked?: boolean;
}

export interface NormalizedAddress {
  original: string;
  normalized: string;
  country: string | null;
  region: string | null;
  city: string | null;
  district: string | null;
  street: string | null;
  houseNumber: string | null;
  postalCode: string | null;
  landmarks: string[];
  latitude: number | null;
  longitude: number | null;
  confidence: "low" | "medium" | "high";
  notes: string[];
}

export interface RouteStop {
  id: string;
  code: string;
  name: string;
  sequence: number;
  position: number;
  /** Administrator-configured static point; unrelated to driver location updates. */
  location?: Coordinates;
}

export interface RouteDefinition {
  id: string;
  name: string;
  currency: "KZT";
  pricePerStopKzt: number;
  active: boolean;
  stops: RouteStop[];
  pitaks?: {
    aStopCode: string;
    bStopCode: string;
    radiusMeters: number;
  };
  /** Disabled unless the administrator supplies the complete explicit policy. */
  externalPickup?: ExternalPickupSettings;
  createdAt: string;
  updatedAt: string;
}

export interface ExternalPickupSettings {
  enabled: boolean;
  serviceRadiusMeters: number;
  pricePerKmKzt: number;
  gpsMaxAgeSeconds: number;
  quoteTtlSeconds: number;
  pickupGraceSeconds: number;
  maxPickupSeconds: number;
  fareRounding: "ceil_kzt" | "nearest_kzt";
}

export interface ExternalPickupSelectionInput {
  routeId: string;
  direction: DriverRouteDirection;
  expectedUpdatedAt: string;
  destinationStopId?: string;
}

/** Authenticated server quote; precise driver coordinates never enter its token. */
export interface ExternalPickupQuote {
  version: 1;
  quoteId: string;
  passengerId: string;
  sessionVersion: number;
  selection: ExternalPickupSelectionInput;
  pickupLocation: Coordinates;
  seats: number;
  driverId: string;
  driverEnrollmentId: string;
  driverLocationFingerprint: string;
  roadDistanceMeters: number;
  roadDurationSeconds: number;
  baseFareKzt: number;
  pickupSurchargeKzt: number;
  totalKzt: number;
  settings: ExternalPickupSettings;
  quotedAt: number;
  expiresAt: number;
  orderId?: string;
  expectedOrderUpdatedAt?: string;
  expectedAttemptedDriverIds?: string[];
  pickupAddress?: string;
}

export interface ExternalPickupSnapshot {
  version: 1;
  quoteId: string;
  requiresPriceConfirmation: boolean;
  driverEnrollmentId: string;
  driverLocationFingerprint: string;
  roadDistanceMeters: number;
  roadDurationSeconds: number;
  baseFareKzt: number;
  pickupSurchargeKzt: number;
  settings: ExternalPickupSettings;
  quotedAt: number;
  quoteExpiresAt: number;
  pickupAddress?: string;
}

export type DriverRouteDirection = "a_to_b" | "b_to_a";

/** A planning preference only; it does not make the legacy queue route-aware. */
export interface DriverRouteChoice {
  routeId: string;
  direction: DriverRouteDirection;
  routeUpdatedAt: string;
}

/** Private driver catalog projection, without pricing or account data. */
export interface DriverRouteOption {
  id: string;
  name: string;
  updatedAt: string;
  stops: RouteStop[];
  pitaks: NonNullable<RouteDefinition["pitaks"]>;
}

export type DriverRouteUnavailableReason =
  | "ROUTE_MISSING"
  | "ROUTE_INACTIVE"
  | "ROUTE_CHANGED"
  | "ROUTE_NOT_CONFIGURED";

export interface DriverRouteSelection {
  choice: DriverRouteChoice | null;
  route: DriverRouteOption | null;
  unavailable_reason: DriverRouteUnavailableReason | null;
}

export interface FareQuote {
  currency: "KZT";
  routeId: string;
  pickupStop: RouteStop;
  destinationStop: RouteStop;
  pickupPosition: number;
  destinationPosition: number;
  distanceStops: number;
  pricePerStopKzt: number;
  minimumFareApplied: boolean;
  stops: RouteStop[];
  totalKzt: number;
  calculatedAt: string;
}

export interface DriverVehicle {
  version: 1;
  revision: string;
  make: string;
  model: string;
  plateNumber: string;
  seatCapacity: number;
  updatedAt: string;
}

export interface DriverVehicleInput {
  make: string;
  model: string;
  plateNumber: string;
  seatCapacity: number;
  expectedRevision: string | null;
}

export interface User {
  id: string;
  role: UserRole;
  /** Account capabilities; role remains the currently active mode. */
  roles: UserRole[];
  fullName: string;
  phoneNumber: string;
  locale: Locale;
  profileLocked: boolean;
  sessionVersion: number;
  driverApprovalStatus?: DriverApprovalStatus;
  driverVehicle?: DriverVehicle;
  /** Exposed only through the authenticated driver's route endpoint. */
  driverRouteChoice?: DriverRouteChoice;
  lastLocation?: Coordinates;
  createdAt: string;
}

export interface OtpChallenge {
  phoneNumber: string;
  code: string;
  role: UserRole;
  locale: Locale;
  fullName?: string;
  expiresAt: number;
}

export interface RouteQueueContext extends DriverRouteChoice {
  routeName: string;
  pitak: "A" | "B";
  stopCode: string;
  stopName: string;
  center: Coordinates;
  radiusMeters: number;
}

/** Opt-in enrollment: collecting seats never implies that the driver departed. */
export interface LineCollectionState {
  version: 1;
  enrollmentId: string;
  phase: "collecting" | "departed";
  capacity: number;
  departedAt?: number;
  /** Server receipt time of the last validated driver location. */
  locationUpdatedAt: number;
}

export interface QueueEntry {
  driverId: string;
  joinedAt: number;
  status: DriverQueueStatus;
  availableSeats: number;
  lastLocation: Coordinates;
  priorityLock: boolean;
  /** Immutable server-derived enrollment snapshot; absent for the legacy lane. */
  routeContext?: RouteQueueContext;
  /** Absent on enrollments using the compatible single-order behavior. */
  collectionState?: LineCollectionState;
  /** False means the driver is in an active-trip pool, not the FIFO set. */
  inFifo?: boolean;
  activeOrderIds?: string[];
  currentOrderId?: string;
  /** Owns the seats reserved for the driver's single pending order offer. */
  pendingOfferOrderId?: string;
  seatLockExpiresAt?: number;
}

export interface Order {
  id: string;
  passengerId: string;
  passengerPhone: string;
  driverId?: string;
  offeredDriverId?: string;
  offerExpiresAt?: number;
  /** Internal dispatch history prevents offering this order to a driver twice. */
  attemptedDriverIds?: string[];
  pickupPoint: PickupPoint;
  /** Origin queue lane; actual selected stops live in the immutable fare snapshot. */
  routeContext?: RouteQueueContext;
  pickupLocation: Coordinates;
  pickupAddress?: NormalizedAddress;
  /** Exact external target is pickupLocation; stop-based fare remains origin -> destination. */
  externalPickup?: ExternalPickupSnapshot;
  routeStops: RouteStop[];
  fare: FareQuote;
  destination: string;
  seats: number;
  status: OrderStatus;
  createdAt: string;
  updatedAt: string;
  seatLockExpiresAt?: number;
  cancelledBy?: string;
}

export interface OrderOfferChange {
  order: Order;
  previousDriverId?: string;
}

export interface DeviceRegistration {
  userId: string;
  deviceToken: string;
  platform: "android" | "ios" | "web";
  createdAt: string;
}
