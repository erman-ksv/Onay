import { Router, type IRouter } from "express";
import { authenticate, requireRole, requireApprovedDriver } from "../middleware/auth";
import { antiFakeGPS } from "../middleware/antiFakeGPS";
import {
  getQueueStatus,
  joinQueue,
  joinLine,
  departQueue,
  leaveQueue,
  updateQueueLocation,
  updateQueueStatus,
} from "../controllers/queueController";

const router: IRouter = Router();

router.get("/queue", authenticate, getQueueStatus);
router.post(
  "/queue/join",
  authenticate,
  requireRole("driver"),
  requireApprovedDriver,
  antiFakeGPS,
  joinQueue,
);
router.post(
  "/queue/line",
  authenticate,
  requireRole("driver"),
  requireApprovedDriver,
  antiFakeGPS,
  joinLine,
);
router.post("/queue/depart", authenticate, requireRole("driver"), requireApprovedDriver, departQueue);
router.delete("/queue/leave", authenticate, requireRole("driver"),
  requireApprovedDriver, leaveQueue);
router.patch(
  "/queue/location",
  authenticate,
  requireRole("driver"),
  requireApprovedDriver,
  antiFakeGPS,
  updateQueueLocation,
);
router.patch(
  "/queue/status",
  authenticate,
  requireRole("driver"),
  requireApprovedDriver,
  updateQueueStatus,
);

export default router;
