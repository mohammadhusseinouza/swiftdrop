import { Prisma } from "../../generated/prisma/client";
import { prisma } from "../../db/prisma";
import { AppError } from "../../shared/errors/app-error";
import {
  DUMMY_PASSWORD_HASH,
  generateRefreshToken,
  hashPassword,
  hashRefreshToken,
  signAccessToken,
  verifyPassword,
} from "./auth.utils";
import { getRolePermissionCodes, toSafeUser } from "./user.service";
import type { AdminBootstrapInput, LoginInput } from "./auth.schema";
import type { LoginResult, SafeUser, UserAccess } from "./auth.types";

const ADMIN_ROLE_CODE = "ADMIN";
const INVALID_CREDENTIALS_MESSAGE = "Invalid email or password";
const INVALID_REFRESH_MESSAGE = "Invalid or expired refresh token";
const DEFAULT_REFRESH_TOKEN_EXPIRES_IN_SECONDS = 60 * 60 * 24 * 30; // 30 days

function getRefreshTokenExpiresInSeconds(): number {
  const configured = Number(process.env.AUTH_REFRESH_TOKEN_EXPIRES_IN);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_REFRESH_TOKEN_EXPIRES_IN_SECONDS;
}

interface IssuedRefreshToken {
  rawToken: string;
  expiresAt: Date;
}

async function createAuthSession(
  tx: Prisma.TransactionClient,
  userId: string
): Promise<IssuedRefreshToken> {
  const rawToken = generateRefreshToken();
  const expiresAt = new Date(Date.now() + getRefreshTokenExpiresInSeconds() * 1000);

  await tx.auth_sessions.create({
    data: {
      user_id: userId,
      refresh_token_hash: hashRefreshToken(rawToken),
      expires_at: expiresAt,
    },
  });

  return { rawToken, expiresAt };
}

function invalidRefreshError(): AppError {
  return new AppError({ statusCode: 401, code: "UNAUTHORIZED", message: INVALID_REFRESH_MESSAGE });
}

export interface CreateFirstAdminResult {
  user: SafeUser;
  employeeNumber: string;
}

export async function createFirstAdmin(input: AdminBootstrapInput): Promise<CreateFirstAdminResult> {
  const passwordHash = await hashPassword(input.password);

  try {
    return await prisma.$transaction(async (tx) => {
      const existingUser = await tx.users.findUnique({ where: { email: input.email } });
      if (existingUser) {
        throw new AppError({
          statusCode: 409,
          code: "CONFLICT",
          message: `A user with email "${input.email}" already exists`,
        });
      }

      const existingEmployee = await tx.employees.findUnique({
        where: { employee_number: input.employeeNumber },
      });
      if (existingEmployee) {
        throw new AppError({
          statusCode: 409,
          code: "CONFLICT",
          message: `An employee with number "${input.employeeNumber}" already exists`,
        });
      }

      const adminRole = await tx.roles.findUnique({ where: { code: ADMIN_ROLE_CODE } });
      if (!adminRole) {
        throw new AppError({
          statusCode: 500,
          code: "INTERNAL_ERROR",
          message: `The "${ADMIN_ROLE_CODE}" role does not exist in the database. Seed the roles table before bootstrapping the first Admin.`,
        });
      }
      if (!adminRole.is_active) {
        throw new AppError({
          statusCode: 500,
          code: "INTERNAL_ERROR",
          message: `The "${ADMIN_ROLE_CODE}" role exists but is inactive.`,
        });
      }

      const user = await tx.users.create({
        data: {
          email: input.email,
          password_hash: passwordHash,
          first_name: input.firstName,
          last_name: input.lastName,
          phone: input.phone,
          role_id: adminRole.id,
        },
      });

      await tx.employees.create({
        data: {
          user_id: user.id,
          employee_number: input.employeeNumber,
        },
      });

      return {
        user: toSafeUser({ ...user, roles: adminRole }),
        employeeNumber: input.employeeNumber,
      };
    });
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new AppError({
        statusCode: 409,
        code: "CONFLICT",
        message: "A user or employee record with conflicting unique data already exists",
      });
    }

    throw new AppError({
      statusCode: 500,
      code: "INTERNAL_ERROR",
      message: "Failed to create the first Admin account",
    });
  }
}

// Internal-only: adds the raw refresh token/expiry so the controller can set
// the HttpOnly cookie. Never serialize this type directly as a JSON response
// — only the fields also present on LoginResult belong in the response body.
export interface LoginServiceResult extends LoginResult {
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

export async function login(input: LoginInput): Promise<LoginServiceResult> {
  const user = await prisma.users.findUnique({
    where: { email: input.email },
    include: { roles: true },
  });

  // Always run a real bcrypt comparison, even when there is no usable
  // account/hash, so unknown-account and inactive-account paths cost
  // approximately the same as a wrong-password check on a real account.
  const hashToVerify = user && user.is_active ? user.password_hash : DUMMY_PASSWORD_HASH;
  const passwordMatches = await verifyPassword(input.password, hashToVerify);

  if (!user || !user.is_active || !passwordMatches) {
    throw new AppError({
      statusCode: 401,
      code: "INVALID_CREDENTIALS",
      message: INVALID_CREDENTIALS_MESSAGE,
    });
  }

  const permissions = await getRolePermissionCodes(user.role_id);
  const accessToken = signAccessToken({ sub: user.id });
  const { rawToken, expiresAt } = await prisma.$transaction((tx) => createAuthSession(tx, user.id));

  return {
    user: toSafeUser(user),
    permissions,
    accessToken,
    refreshToken: rawToken,
    refreshTokenExpiresAt: expiresAt,
  };
}

export interface RefreshResult {
  accessToken: string;
}

interface RefreshServiceResult extends RefreshResult {
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

export async function refreshSession(rawRefreshToken: string | undefined): Promise<RefreshServiceResult> {
  if (!rawRefreshToken) {
    throw invalidRefreshError();
  }

  const tokenHash = hashRefreshToken(rawRefreshToken);
  const now = new Date();

  const result = await prisma.$transaction(async (tx) => {
    // Atomically consume the credential: this WHERE clause is the sole
    // source of truth for "valid, unrevoked, unexpired" — a concurrent
    // second attempt to consume the same token finds 0 rows here (Postgres
    // serializes the conditional UPDATE), so a refresh token can never be
    // used successfully more than once.
    const { count } = await tx.auth_sessions.updateMany({
      where: { refresh_token_hash: tokenHash, revoked_at: null, expires_at: { gt: now } },
      data: { revoked_at: now },
    });

    if (count === 0) {
      return null;
    }

    const session = await tx.auth_sessions.findUniqueOrThrow({
      where: { refresh_token_hash: tokenHash },
    });
    const user = await tx.users.findUnique({ where: { id: session.user_id } });

    if (!user || !user.is_active) {
      // The stale/inactive-account session stays revoked (this transaction
      // still commits) — only the rotation into a fresh session is skipped.
      return null;
    }

    const issued = await createAuthSession(tx, user.id);
    const accessToken = signAccessToken({ sub: user.id });

    return {
      accessToken,
      refreshToken: issued.rawToken,
      refreshTokenExpiresAt: issued.expiresAt,
    };
  });

  if (!result) {
    throw invalidRefreshError();
  }

  return result;
}

export async function logout(rawRefreshToken: string | undefined): Promise<void> {
  if (!rawRefreshToken) {
    return;
  }

  const tokenHash = hashRefreshToken(rawRefreshToken);

  // Idempotent by construction: matches 0 or 1 rows either way, never
  // throws, and never reveals whether a session existed.
  await prisma.auth_sessions.updateMany({
    where: { refresh_token_hash: tokenHash, revoked_at: null },
    data: { revoked_at: new Date() },
  });
}

export async function getCurrentUser(userId: string): Promise<UserAccess> {
  const user = await prisma.users.findUnique({
    where: { id: userId },
    include: { roles: true },
  });

  if (!user || !user.is_active) {
    throw new AppError({ statusCode: 401, code: "UNAUTHORIZED", message: "Account is not available" });
  }

  const permissions = await getRolePermissionCodes(user.role_id);

  return {
    user: toSafeUser(user),
    permissions,
  };
}
