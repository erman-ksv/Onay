import { Router, type IRouter } from "express";
import { authenticate, requireRole } from "../middleware/auth";
import {
  addStop,
  cancelAdminOrder,
  listAdminAuditEvents,
  createRoute,
  deleteRoute,
  deleteStop,
  getQueuePoint,
  getAdminRoute,
  getTripStatistics,
  listAdminOrders,
  listAdminQueue,
  listDrivers,
  listPassengers,
  listRoutes,
  updateDriverApproval,
  updateDriverBlock,
  updateQueuePoint,
  updateRoute,
  updateRouteLayout,
  updateExternalPickupSettings,
  updateStop,
} from "../controllers/adminController";

const router: IRouter = Router();
const adminOnly = [authenticate, requireRole("admin")] as const;

router.get("/admin/routes", ...adminOnly, listRoutes);
router.get("/admin/routes/:routeId", ...adminOnly, getAdminRoute);
router.put("/admin/routes/:routeId/layout", ...adminOnly, updateRouteLayout);
router.put("/admin/routes/:routeId/external-pickup", ...adminOnly, updateExternalPickupSettings);
router.post("/admin/routes", ...adminOnly, createRoute);
router.patch("/admin/routes/:routeId", ...adminOnly, updateRoute);
router.delete("/admin/routes/:routeId", ...adminOnly, deleteRoute);
router.post("/admin/routes/:routeId/stops", ...adminOnly, addStop);
router.patch("/admin/routes/:routeId/stops/:stopId", ...adminOnly, updateStop);
router.delete("/admin/routes/:routeId/stops/:stopId", ...adminOnly, deleteStop);
router.get("/admin/orders", ...adminOnly, listAdminOrders);
router.get("/admin/audit-events", ...adminOnly, listAdminAuditEvents);
router.post("/admin/orders/:orderId/cancel", ...adminOnly, cancelAdminOrder);
router.get("/admin/statistics/trips", ...adminOnly, getTripStatistics);
router.get("/admin/queue", ...adminOnly, listAdminQueue);
router.get("/admin/drivers", ...adminOnly, listDrivers);
router.get("/admin/passengers", ...adminOnly, listPassengers);
router.get("/admin/queue-point", ...adminOnly, getQueuePoint);
router.patch("/admin/queue-point", ...adminOnly, updateQueuePoint);
router.patch("/admin/drivers/:driverId/block", ...adminOnly, updateDriverBlock);
router.patch(
  "/admin/drivers/:driverId/approval",
  ...adminOnly,
  updateDriverApproval,
);

export default router;
