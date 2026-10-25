import type { Request, Response } from "express";
import { calculateRouteFare, getRouteStops, parseRouteStopCodes } from "../utils/fare";
import { store } from "../store";
import { routePricePerStop } from "../utils/routePricing";

export async function listFareStops(_request: Request, response: Response): Promise<void> {
  const routeId = typeof _request.query.route_id === "string"
    ? _request.query.route_id
    : "pyatak";
  const route = await store.getRoute(routeId);
  const stops = await getRouteStops(routeId);
  response.json({
    route_id: routeId,
    currency: route!.currency,
    price_per_stop: routePricePerStop(route!),
    stops,
  });
}

export async function estimateFare(request: Request, response: Response): Promise<void> {
  const stopCodes = parseRouteStopCodes(request.body?.route_stops);
  response.json({
    route_id: request.body?.route_id ?? "pyatak",
    fare: await calculateRouteFare({
      routeId: request.body?.route_id,
      pickupStop: request.body?.pickup_stop,
      destinationStop: request.body?.destination_stop,
      routeStops: stopCodes.length > 0 ? stopCodes : undefined,
    }),
  });
}
