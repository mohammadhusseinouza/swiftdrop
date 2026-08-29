import { NextFunction, Request, Response } from "express";
import { AppError } from "../shared/errors/app-error";
import { verifyAccessToken } from "../modules/auth/auth.utils";
import { getCurrentUser } from "../modules/auth/auth.service";

export interface AuthenticatedActor {
  userId: string;
  role: {
    id: string;
    code: string;
  };
  permissions: string[];
}

declare module "express-serve-static-core" {
  interface Request {
    actor?: AuthenticatedActor;
  }
}

function extractBearerToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return undefined;
  }

  const token = header.slice("Bearer ".length).trim();
  return token.length > 0 ? token : undefined;
}

// Verifies the access token, then reloads the user/role/permissions from the
// database (never trusting role/permissions embedded in the JWT) and
// attaches the resulting trusted actor context to the request. This means a
// permission or active-status change in the database takes effect on the
// very next request, without waiting for the access token to expire.
export async function authenticate(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const token = extractBearerToken(req);

  if (!token) {
    next(new AppError({ statusCode: 401, code: "UNAUTHORIZED", message: "Authentication required" }));
    return;
  }

  let userId: string;
  try {
    userId = verifyAccessToken(token).sub;
  } catch {
    next(new AppError({ statusCode: 401, code: "UNAUTHORIZED", message: "Invalid or expired access token" }));
    return;
  }

  try {
    const { user, permissions } = await getCurrentUser(userId);
    req.actor = { userId: user.id, role: user.role, permissions };
    next();
  } catch (error) {
    // getCurrentUser already throws a safe 401 AppError for a missing/inactive user.
    next(error);
  }
}
