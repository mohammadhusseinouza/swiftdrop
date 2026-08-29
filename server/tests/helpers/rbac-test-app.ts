import express, { Express } from "express";
import { authenticate } from "../../src/middleware/authenticate";
import { authorize } from "../../src/middleware/authorize";
import { notFound } from "../../src/middleware/not-found";
import { errorHandler } from "../../src/middleware/error-handler";

// Test-only harness (never imported by production code) that exercises the
// REAL authenticate/authorize middleware against an arbitrary permission
// code supplied per-request. authorize() itself is still called exactly as
// production code calls it — only the permission string's origin (a route
// param, for generic test coverage) differs from a hardcoded business route.
export function createRbacTestApp(): Express {
  const app = express();
  app.use(express.json());

  app.get("/rbac/:permission", authenticate, (req, res, next) => {
    // authorize()'s own "next" contract: called with an error on rejection,
    // called with no args on success. Forward a rejection to the real
    // Express `next` so the centralized error handler still produces it —
    // never treat "was called" as "succeeded".
    authorize(req.params.permission)(req, res, (err?: unknown) => {
      if (err) {
        next(err);
        return;
      }
      res.json({ success: true, data: { ok: true } });
    });
  });

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
