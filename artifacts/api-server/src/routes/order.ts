import { Router, type IRouter } from "express";
import { authenticate, requireRole, requireApprovedDriver } from "../middleware/auth";
import { antiFakeGPS } from "../middleware/antiFakeGPS";
import { createExternalPickupQuote, confirmExternalPickup } from "../controllers/externalPickupController";
import {
  acceptOrder,
  boardOrder,
  cancelOrder,
  createOrder,
  createRouteOrder,
  getOrder,
  getAssignedDriver,
  getOrderAvailability,
  getRouteOrderAvailability,
  getRouteOrderRequest,
  resolveRouteOrderRequest,
  listOrderRoutes,
  listOrders,
  newRouteOrderRequestKey,
  offerToFirstDriver,
  rejectOrder,
  replayRouteOrderRequest,
  updateOrderStatus,
  validateRouteOrderRequest,
} from "../controllers/orderController";

const router: IRouter = Router();

router.get("/orders", authenticate, listOrders);
router.get("/orders/availability", authenticate, requireRole("passenger"), getOrderAvailability);
router.get("/orders/routes", authenticate, requireRole("passenger"), listOrderRoutes);
router.post("/orders/external/quote", authenticate, requireRole("passenger"), createExternalPickupQuote);
router.post("/orders/external/confirm", authenticate, requireRole("passenger"), confirmExternalPickup);
router.get("/orders/route/availability", authenticate, requireRole("passenger"), getRouteOrderAvailability);
router.get("/orders/route/request-key", authenticate, requireRole("passenger"), newRouteOrderRequestKey);
router.get("/orders/route/requests/:requestKey", authenticate, requireRole("passenger"), getRouteOrderRequest);
router.post("/orders/route/requests/:requestKey/resolve", authenticate, requireRole("passenger"), resolveRouteOrderRequest);
router.post(
  "/orders/route",
  authenticate,
  requireRole("passenger"),
  validateRouteOrderRequest,
  replayRouteOrderRequest,
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
router.get("/orders/:orderId/driver", authenticate, requireRole("passenger"), getAssignedDriver);
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
