import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import queueRouter from "./queue";
import orderRouter from "./order";
import notificationRouter from "./notifications";
import addressRouter from "./address";
import fareRouter from "./fare";
import adminRouter from "./admin";
import driverRouter from "./driver";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(queueRouter);
router.use(orderRouter);
router.use(notificationRouter);
router.use(addressRouter);
router.use(fareRouter);
router.use(adminRouter);
router.use(driverRouter);

export default router;

