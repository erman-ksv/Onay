import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { errorHandler } from "./middleware/errorHandler";
import { AppError, serializeSafeError } from "./utils/errors";
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
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", (request, _response, next) => {
  markApiRequest(request);
  next();
}, router);
app.use((_request, _response, next) => {
  next(new AppError(404, "API endpoint not found", "NOT_FOUND"));
});
app.use(errorHandler);

export default app;
