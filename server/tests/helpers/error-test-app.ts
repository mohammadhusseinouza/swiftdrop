import express, { Express } from "express";
import { notFound } from "../../src/middleware/not-found";
import { errorHandler } from "../../src/middleware/error-handler";
import { prisma } from "../../src/db/prisma";

// Test-only harness (never imported by production code) exercising the REAL
// centralized errorHandler against a genuine unexpected error, without
// adding a permanent debug route to production.
export function createErrorTestApp(): Express {
  const app = express();
  app.use(express.json());

  app.get("/boom", () => {
    throw new Error("unexpected failure with a fake stack trace and /c/secret/path");
  });

  // A REAL interactive-transaction timeout (Prisma P2028): the transaction
  // runs longer than its 100 ms timeout. Read-only — it writes nothing.
  app.get("/transaction-timeout", async (_req, _res, next) => {
    try {
      await prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_sleep(0.4)`;
          await tx.$queryRaw`SELECT 1`;
        },
        { timeout: 100 }
      );
    } catch (error) {
      next(error);
    }
  });

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
