import { Router, type IRouter } from "express";
import { getDriverVehicle, setDriverVehicle, clearDriverRoute, getDriverRoute, getDriverRoutes, setDriverRoute } from "../controllers/driverController";
import { authenticate, requireApprovedDriver, requireRole } from "../middleware/auth";

const router: IRouter = Router();
// Own vehicle snapshot is read-only for an authenticated passenger too.
router.get("/driver/vehicle", authenticate, getDriverVehicle);
router.put("/driver/vehicle", authenticate, requireRole("driver"), setDriverVehicle);

const driverAccess = [authenticate, requireRole("driver"), requireApprovedDriver];

router.get("/driver/routes", ...driverAccess, getDriverRoutes);
router.get("/driver/route", ...driverAccess, getDriverRoute);
router.put("/driver/route", ...driverAccess, setDriverRoute);
router.delete("/driver/route", ...driverAccess, clearDriverRoute);

export default router;
