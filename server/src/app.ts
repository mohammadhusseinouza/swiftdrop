import express, { Express } from "express";
import cookieParser from "cookie-parser";
import { apiRouter } from "./routes";
import { notFound } from "./middleware/not-found";
import { errorHandler } from "./middleware/error-handler";

export function createApp(): Express {
  const app = express();

  app.use(express.json());
  app.use(cookieParser());

  app.use("/api/v1", apiRouter);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
const app = createApp();

export default app;
