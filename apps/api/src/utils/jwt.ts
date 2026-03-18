// src/server/utils/jwt.ts
import jwt from "jsonwebtoken";
import { setCache, getCache, getKv } from "./kv-cache";

// Default JWT expiration time (1 hour)
const DEFAULT_EXPIRATION = "1h";

// Token blacklist key prefix
const BLACKLIST_KEY_PREFIX = "jwt:blacklist:";

// KV minimum TTL is 60 seconds. Tokens expiring sooner are still stored for
// 60 s – an acceptable security trade-off for short-lived tokens.
const MIN_BLACKLIST_TTL = 60;

interface JwtEnv {
  JWT_SECRET?: string;
  [key: string]: unknown;
}

/**
 * Retrieve the JWT secret from the Workers env or process.env.
 * Called at request time (not module load) to avoid the missing-env issue.
 */
function getJwtSecret(env?: JwtEnv): string {
  const secret =
    env?.JWT_SECRET ||
    (typeof process !== "undefined" ? process.env.JWT_SECRET : undefined) ||
    "your-jwt-secret-key-change-this-in-production";

  if (
    typeof process !== "undefined" &&
    process.env.NODE_ENV === "production" &&
    secret === "your-jwt-secret-key-change-this-in-production"
  ) {
    throw new Error(
      "CRITICAL SECURITY ERROR: Using default JWT secret in production. Set JWT_SECRET environment variable.",
    );
  }

  return secret;
}

/**
 * Generate a JWT token.
 */
export function generateToken(
  payload: Record<string, unknown>,
  expiresIn: string = DEFAULT_EXPIRATION,
  env?: JwtEnv,
): string {
  try {
    const secret = getJwtSecret(env);
    return (jwt.sign as (...args: unknown[]) => string)(payload, secret, { expiresIn });
  } catch (error: unknown) {
    console.error("Error generating JWT token:", error);
    throw new Error("Failed to generate authentication token");
  }
}

/**
 * Verify a JWT token. Checks the blacklist and signature.
 */
export async function verifyToken(
  token: string,
  env?: JwtEnv,
): Promise<jwt.JwtPayload | string> {
  try {
    if (await isTokenBlacklisted(token)) {
      throw new Error("Token has been revoked");
    }

    const secret = getJwtSecret(env);
    return (jwt.verify as (...args: unknown[]) => jwt.JwtPayload | string)(token, secret);
  } catch (error: unknown) {
    if (error instanceof jwt.JsonWebTokenError) {
      throw new Error("Invalid token");
    }
    throw error;
  }
}

/**
 * Decode a JWT token without verification.
 */
export function decodeToken(token: string): jwt.JwtPayload | string | null {
  try {
    return jwt.decode(token);
  } catch (error: unknown) {
    console.error("Error decoding JWT token:", error);
    throw new Error("Failed to decode token");
  }
}

/**
 * Check if a token is about to expire within `thresholdMinutes`.
 */
export function isTokenExpiringSoon(
  token: string,
  thresholdMinutes = 5,
): boolean {
  try {
    const decoded = jwt.decode(token) as { exp?: number };
    if (!decoded?.exp) return true;
    return decoded.exp * 1000 - Date.now() < thresholdMinutes * 60 * 1000;
  } catch {
    return true;
  }
}

/**
 * Refresh a token if it is close to expiry.
 */
export function refreshTokenIfNeeded(
  token: string,
  thresholdMinutes = 5,
  env?: JwtEnv,
): string {
  try {
    if (isTokenExpiringSoon(token, thresholdMinutes)) {
      const decoded = jwt.decode(token) as Record<string, unknown>;
      const { iat, exp, nbf, jti, ...payload } = decoded;
      return generateToken(payload, DEFAULT_EXPIRATION, env);
    }
    return token;
  } catch (error: unknown) {
    console.error("Error refreshing token:", error);
    throw new Error("Failed to refresh token");
  }
}

/**
 * Revoke a token by storing it in the KV blacklist.
 */
export async function revokeToken(token: string): Promise<void> {
  try {
    const decoded = jwt.decode(token) as { exp?: number };
    if (!decoded?.exp) throw new Error("Invalid token format");

    const expiresAt = decoded.exp * 1000;
    const ttlSeconds = Math.max(
      MIN_BLACKLIST_TTL,
      Math.floor((expiresAt - Date.now()) / 1000),
    );

    const tokenHash = Buffer.from(token).toString("base64").slice(0, 32);
    const kv = getKv();
    await setCache(
      `${BLACKLIST_KEY_PREFIX}${tokenHash}`,
      { revoked: true },
      ttlSeconds,
      kv,
    );

    if (typeof process !== "undefined" && process.env.NODE_ENV === "production") {
      console.log(`Token revoked, expires at ${new Date(expiresAt).toISOString()}`);
    }
  } catch (error: unknown) {
    console.error("Error revoking token:", error);
    throw new Error("Failed to revoke token");
  }
}

/**
 * Check if a token is in the KV blacklist.
 */
export async function isTokenBlacklisted(token: string): Promise<boolean> {
  try {
    const tokenHash = Buffer.from(token).toString("base64").slice(0, 32);
    const kv = getKv();
    const result = await getCache<{ revoked: boolean }>(
      `${BLACKLIST_KEY_PREFIX}${tokenHash}`,
      kv,
    );
    return result?.revoked === true;
  } catch (error: unknown) {
    console.error("Error checking token blacklist:", error);
    return false; // Fail open to avoid blocking valid requests
  }
}

/**
 * Extract Bearer token from Authorization header.
 */
export function extractTokenFromHeader(
  authHeader: string | null,
): string | null {
  if (!authHeader?.startsWith("Bearer ")) return null;
  return authHeader.substring(7);
}

/**
 * Get token statistics (for diagnostics).
 */
export function getTokenStats(
  env?: JwtEnv,
): {
  blacklistStorage: string;
  jwtSecret: string;
  isUsingDefaultSecret: boolean;
} {
  const secret = env?.JWT_SECRET || process.env?.JWT_SECRET || "";
  const defaultSecret = "your-jwt-secret-key-change-this-in-production";
  return {
    blacklistStorage: "cloudflare-kv",
    jwtSecret:
      typeof secret === "string" && secret.length > 6
        ? `${secret.substring(0, 3)}...${secret.substring(secret.length - 3)}`
        : "***",
    isUsingDefaultSecret: secret === defaultSecret,
  };
}
