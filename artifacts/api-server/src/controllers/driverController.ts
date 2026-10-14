import type { Request, Response } from "express";
import { store } from "../store";
import type { DriverRouteChoice, DriverRouteSelection, User } from "../types/domain";
import { REQUIRE_DRIVER_APPROVAL } from "../utils/config";
import { driverRouteOption, driverRouteSelection, readDriverRouteChoiceInput } from "../utils/driverRoute";
import { AppError } from "../utils/errors";

/** Read the actor's live private state rather than a public user projection. */
async function currentDriver(request: Request): Promise<User> {
  const auth = request.auth;
  const user = auth ? await store.getUser(auth.userId) : undefined;
  if (!auth || !user || user.sessionVersion !== auth.user.sessionVersion) {
    throw new AppError(401, "Session is no longer valid", "UNAUTHORIZED");
  }
  if (user.role !== "driver") throw new AppError(403, "driver mode is required", "FORBIDDEN");
  if (REQUIRE_DRIVER_APPROVAL && user.driverApprovalStatus !== "approved") {
    throw new AppError(403, "Driver approval is required", "DRIVER_APPROVAL_REQUIRED");
  }
  return user;
}

async function selection(choice: DriverRouteChoice | undefined | null): Promise<DriverRouteSelection> {
  const route = choice ? await store.getRoute(choice.routeId) : undefined;
  return driverRouteSelection(choice, route);
}

export async function getDriverRoutes(request: Request, response: Response): Promise<void> {
  await currentDriver(request);
  const routes = (await store.listRoutes()).flatMap(route => {
    if (!route || route.active !== true) return [];
    const option = driverRouteOption(route);
    return option ? [option] : [];
  });
  response.json({ routes });
}

export async function getDriverRoute(request: Request, response: Response): Promise<void> {
  const user = await currentDriver(request);
  response.json(await selection(user.driverRouteChoice));
}

export async function setDriverRoute(request: Request, response: Response): Promise<void> {
  const input = readDriverRouteChoiceInput(request.body);
  const user = await currentDriver(request);
  const choice = await store.setDriverRouteChoice(user.id, input, request.auth!.user.sessionVersion);
  response.json(await selection(choice));
}

export async function clearDriverRoute(request: Request, response: Response): Promise<void> {
  const user = await currentDriver(request);
  await store.setDriverRouteChoice(user.id, null, request.auth!.user.sessionVersion);
  response.status(204).send();
}
