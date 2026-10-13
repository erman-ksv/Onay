import type { Request, Response } from "express";
import { store } from "../store";
import { AppError } from "../utils/errors";
import { emitIncomingOrder } from "../utils/realtime";
import { calculateFixedFare } from "../utils/fare";
import { pickEnum, requiredString } from "../utils/validation";

export function getNotificationConfig(_request: Request, response: Response): void {
  response.json({
    transport: "socket.io",
    high_priority_event: "incoming_order",
    sound_asset: "incoming_order.mp3",
    delivery_room: "user:{user_id}",
    supported_push_platforms: ["android", "ios", "web"],
  });
}

export async function registerDevice(request: Request, response: Response): Promise<void> {
  if (!request.auth) {
    throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
  }
  const deviceToken = requiredString(request.body?.device_token, "device_token", 512);
  const platform = pickEnum(request.body?.platform, "platform", [
    "android",
    "ios",
    "web",
  ] as const);
  const registration = await store.saveDeviceRegistration(
    request.auth.userId,
    deviceToken,
    platform,
  );
  response.status(201).json({ registration });
}

export async function listDevices(request: Request, response: Response): Promise<void> {
  if (!request.auth) {
    throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
  }
  response.json({
    devices: (await store.getDeviceRegistrations(request.auth.userId)).map((device) => ({
      platform: device.platform,
      created_at: device.createdAt,
    })),
  });
}

export async function testHighPriorityAlert(request: Request, response: Response): Promise<void> {
  if (!request.auth) {
    throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
  }
  const fare = await calculateFixedFare(["C"]);
  emitIncomingOrder(request.app.locals.io, request.auth.userId, {
    id: "test-alert",
    passengerId: "test-passenger",
    passengerPhone: "+70000000000",
    pickupPoint: "C",
    pickupLocation: { lat: 0, lng: 0, timestamp: Date.now() },
    routeStops: fare.stops,
    fare,
    destination: "Test alert",
    seats: 1,
    status: "searching",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  response.status(202).json({
    sent: true,
    event: "incoming_order",
    priority: "high",
    sound: "incoming_order.mp3",
  });
}