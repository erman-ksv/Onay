import type { Order, User } from "../types/domain";
import { maskPhone } from "./phone";
import { withCanonicalFare } from "./fareMoney";
import { serializeExternalPickup } from "./externalMoney";

export function serializeUser(user: User) {
  return {
    id: user.id,
    role: user.role,
    active_role: user.role,
    roles: user.roles,
    full_name: user.fullName,
    phone_number: user.phoneNumber,
    locale: user.locale,
    profile_locked: user.profileLocked,
    driver_approval_status: user.driverApprovalStatus,
    ...(user.driverVehicle ? { driver_vehicle: {
      revision: user.driverVehicle.revision, make: user.driverVehicle.make, model: user.driverVehicle.model,
      plate_number: user.driverVehicle.plateNumber, seat_capacity: user.driverVehicle.seatCapacity, updated_at: user.driverVehicle.updatedAt,
    } } : {}),
    created_at: user.createdAt,
  };
}

export function serializeOrder(order: Order, maskPassenger = false) {
  return {
    id: order.id,
    passenger_id: order.passengerId,
    passenger_phone: maskPassenger
      ? maskPhone(order.passengerPhone)
      : order.passengerPhone,
    driver_id: order.driverId,
    offered_driver_id: order.offeredDriverId,
    offer_expires_at: order.offerExpiresAt,
    pickup_point: order.pickupPoint,
    pickup_location: order.pickupLocation,
    pickup_address: order.pickupAddress,
    ...(order.externalPickup ? { external_pickup: serializeExternalPickup(order) } : {}),
    ...(order.routeContext ? {
      route_context: order.routeContext,
      pickup_stop_id: order.fare.pickupStop.id,
      destination_stop_id: order.fare.destinationStop.id,
    } : {}),
    route_stops: order.routeStops,
    fare: withCanonicalFare(order.fare),
    destination: order.destination,
    seats: order.seats,
    status: order.status,
    created_at: order.createdAt,
    updated_at: order.updatedAt,
    seat_lock_expires_at: order.seatLockExpiresAt,
  };
}
