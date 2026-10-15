import { Router, type IRouter } from "express";
import { authenticate, requireRole, requireApprovedDriver } from "../middleware/auth";
import { antiFakeGPS } from "../middleware/antiFakeGPS";
import {
  acceptOrder,
  boardOrder,
  cancelOrder,
  createOrder,
  createRouteOrder,
  getOrder,
  getOrderAvailability,
  getRouteOrderAvailability,
  listOrderRoutes,
  listOrders,
  offerToFirstDriver,
  rejectOrder,
  updateOrderStatus,
  validateRouteOrderRequest,
} from "../controllers/orderController";

const router: IRouter = Router();

router.get("/orders", authenticate, listOrders);
router.get("/orders/availability", authenticate, requireRole("passenger"), getOrderAvailability);
router.get("/orders/routes", authenticate, requireRole("passenger"), listOrderRoutes);
router.get("/orders/route/availability", authenticate, requireRole("passenger"), getRouteOrderAvailability);
router.post(
  "/orders/route",
  authenticate,
  requireRole("passenger"),
  validateRouteOrderRequest,
  antiFakeGPS,
  createRouteOrder,
);
router.post(
  "/orders",
  authenticate,
  requireRole("passenger"),
  antiFakeGPS,
  createOrder,
);
router.get("/orders/:orderId", authenticate, getOrder);
router.post(
  "/orders/:orderId/accept",
  authenticate,
  requireRole("driver"),
  requireApprovedDriver,
  acceptOrder,
);
router.post(
  "/orders/:orderId/reject",
  authenticate,
  requireRole("driver"),
  requireApprovedDriver,
  rejectOrder,
);
router.patch(
  "/orders/:orderId/status",
  authenticate,
  requireRole("driver"),
  requireApprovedDriver,
  antiFakeGPS,
  updateOrderStatus,
);
router.post("/orders/:orderId/board", authenticate, requireRole("driver"), requireApprovedDriver, boardOrder);
router.post("/orders/:orderId/cancel", authenticate, cancelOrder);
router.post(
  "/orders/:orderId/offer-first-driver",
  authenticate,
  requireRole("driver"),
  requireApprovedDriver,
  offerToFirstDriver,
);

export default router;
