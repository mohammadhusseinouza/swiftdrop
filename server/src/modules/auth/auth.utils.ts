import { randomBytes, createHash } from "node:crypto";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import type { StringValue } from "ms";

const SALT_ROUNDS = 12;

export async function hashPassword(plainPassword: string): Promise<string> {
  return bcrypt.hash(plainPassword, SALT_ROUNDS);
}

export async function verifyPassword(plainPassword: string, passwordHash: string): Promise<boolean> {
  return bcrypt.compare(plainPassword, passwordHash);
}

// A fixed, valid bcrypt hash (same work factor as real password hashes) with
// no corresponding real password. Login verifies against this when no real
// user/hash is usable, so unknown-account and inactive-account paths cost
// approximately the same as a wrong-password check on a real account,
// instead of short-circuiting before bcrypt ever runs. Generated once at
// module load, not per request.
export const DUMMY_PASSWORD_HASH = bcrypt.hashSync("dummy-password-for-timing-safety", SALT_ROUNDS);

const ACCESS_TOKEN_ALGORITHM = "HS256";
const DEFAULT_ACCESS_TOKEN_EXPIRES_IN = "15m";

export interface AccessTokenClaims {
  sub: string;
}

function getAccessTokenSecret(): string {
  const secret = process.env.AUTH_ACCESS_TOKEN_SECRET;
  if (!secret) {
    throw new Error("AUTH_ACCESS_TOKEN_SECRET is not set");
  }
  return secret;
}

function getAccessTokenExpiresIn(): StringValue {
  // Expected to be a duration string understood by the `ms` package (e.g. "15m", "1h").
  return (process.env.AUTH_ACCESS_TOKEN_EXPIRES_IN || DEFAULT_ACCESS_TOKEN_EXPIRES_IN) as StringValue;
}

export function signAccessToken(claims: AccessTokenClaims): string {
  return jwt.sign(claims, getAccessTokenSecret(), {
    algorithm: ACCESS_TOKEN_ALGORITHM,
    expiresIn: getAccessTokenExpiresIn(),
  });
}

// Verifies signature, algorithm, and expiration, then checks the decoded
// payload has the expected shape before trusting it. Never use jwt.decode()
// (no verification) for authentication.
export function verifyAccessToken(token: string): AccessTokenClaims {
  const decoded = jwt.verify(token, getAccessTokenSecret(), {
    algorithms: [ACCESS_TOKEN_ALGORITHM],
  });

  if (typeof decoded !== "object" || decoded === null || typeof decoded.sub !== "string" || !decoded.sub) {
    throw new Error("Access token payload is missing a valid subject claim");
  }

  return { sub: decoded.sub };
}

// Opaque, high-entropy refresh token. Not a human password, so a fast
// cryptographic hash (not bcrypt) is appropriate and sufficient for lookup.
export function generateRefreshToken(): string {
  return randomBytes(32).toString("hex");
}

export function hashRefreshToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}
