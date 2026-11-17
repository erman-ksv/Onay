import { Router, type IRouter } from "express";
import { authenticate } from "../middleware/auth";
import { getOwnDriverOverview } from "../controllers/driverController";

import {
  getCurrentUser,
  logout,
  requestOtp,
  switchRole,
  updateProfile,
  verifyOtp,
} from "../controllers/authController";

const router: IRouter = Router();

router.post("/auth/request-otp", requestOtp);
router.post("/auth/verify-otp", verifyOtp);
router.post("/auth/login", verifyOtp);
router.get("/auth/me", authenticate, getCurrentUser);
router.get("/auth/driver-overview", authenticate, getOwnDriverOverview);
router.patch("/auth/profile", authenticate, updateProfile);
router.post("/auth/logout", authenticate, logout);
router.post("/auth/switch-role", authenticate, switchRole);

export default router;
