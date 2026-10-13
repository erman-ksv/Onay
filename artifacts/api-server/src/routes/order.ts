import { Router, type IRouter } from "express";
import { authenticate, requireRole, requireApprovedDriver } from "../middleware/auth";
import { antiFakeGPS } from "../middleware/antiFakeGPS";
import {
  acceptOrder,
  cancelOrder,
  createOrder,
  getOrder,
  getOrderAvailability,
  listOrders,
  offerToFirstDriver,
  rejectOrder,
  updateOrderStatus,
} from "../controllers/orderController";

const router: IRouter = Router();

router.get("/orders", authenticate, listOrders);
router.get("/orders/availability", authenticate, requireRole("passenger"), getOrderAvailability);
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
router.post("/orders/:orderId/cancel", authenticate, cancelOrder);
router.post(
  "/orders/:orderId/offer-first-driver",
  authenticate,
  requireRole("driver"),
  requireApprovedDriver,
  offerToFirstDriver,
);

export default router;
