import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { errorHandler } from "./middleware/errorHandler";
import { otpBodyError, protectOtpRequests } from "./middleware/otpProtection";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use("/api", protectOtpRequests);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use("/api", otpBodyError);

app.use("/api", router);
app.use(errorHandler);

export default app;
