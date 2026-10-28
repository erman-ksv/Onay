import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { errorHandler } from "./middleware/errorHandler";
import { protectOtpRequests } from "./middleware/otpProtection";
import { AppError, serializeSafeError } from "./utils/errors";
import { fileURLToPath } from "node:url";
import { mountAdminUi } from "./middleware/adminUi";
import { generateRequestId, markApiRequest, requestContext } from "./utils/requestContext";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    genReqId: generateRequestId,
    wrapSerializers: false,
    serializers: {
      err: serializeSafeError,
      req(req) {
        const context = requestContext(req);
        return {
          id: context.request_id,
          method: context.method,
          route: context.route,
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
    customSuccessObject(req, _res, value) {
      return { ...value, ...requestContext(req) };
    },
    customErrorObject(req, _res, _error, value) {
      return { ...value, ...requestContext(req) };
    },
  }),
);
app.use(cors());
// Tokens and private profiles must not be stored by HTTP caches. Mount before
// the OTP limiter and body parsers so their early failures carry the same policy.
app.use("/api/auth", (_request, response, next) => {
  response.set("Cache-Control", "no-store");
  next();
});
app.use("/api", protectOtpRequests);
// Admin responses contain private account and operational data. Apply before
// body parsing and authentication so failures and HEAD responses cannot be cached.
app.use("/api/admin", (_request, response, next) => {
  response.set("Cache-Control", "no-store");
  next();
});
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", (request, _response, next) => {
  markApiRequest(request);
  next();
}, router);
if (process.env.TEZJET_SERVE_ADMIN_UI === "true") {
  mountAdminUi(app, fileURLToPath(new URL("../../mockup-sandbox/dist/", import.meta.url)));
}
app.use((_request, _response, next) => {
  next(new AppError(404, "API endpoint not found", "NOT_FOUND"));
});
app.use(errorHandler);

export default app;

