import express, { Express } from "express";
import { notFound } from "../../src/middleware/not-found";
import { errorHandler } from "../../src/middleware/error-handler";

// Test-only harness (never imported by production code) exercising the REAL
// centralized errorHandler against a genuine unexpected error, without
// adding a permanent debug route to production.
export function createErrorTestApp(): Express {
  const app = express();
  app.use(express.json());

  app.get("/boom", () => {
    throw new Error("unexpected failure with a fake stack trace and /c/secret/path");
  });

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
