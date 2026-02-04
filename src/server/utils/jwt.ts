import jwt from "jsonwebtoken";
import { setCache, getCache } from "./redis";

// Default JWT expiration time (1 hour)
const DEFAULT_EXPIRATION = "1h";

// JWT Secret from environment variable or fallback
const JWT_SECRET_STRING =
  process.env.JWT_SECRET || "your-jwt-secret-key-change-this-in-production";

// Check if we're in production and throw an error if using the default JWT secret
if (
  process.env.NODE_ENV === "production" &&
  JWT_SECRET_STRING === "your-jwt-secret-key-change-this-in-production"
) {
  throw new Error(
    "CRITICAL SECURITY ERROR: Using default JWT secret in production. Set JWT_SECRET environment variable.",
  );
}

// Token blacklist key prefix for Redis
const BLACKLIST_KEY_PREFIX = "jwt:blacklist:";

/**
 * Generate a JWT token
 */
export function generateToken(
  payload: Record<string, any>,
  expiresIn: string = DEFAULT_EXPIRATION,
): string {
  try {
    // Use any type to avoid TypeScript errors
    const jwtSign: any = jwt.sign;
    return jwtSign(payload, JWT_SECRET_STRING, { expiresIn });
  } catch (error) {
    console.error("Error generating JWT token:", error);
    throw new Error("Failed to generate authentication token");
  }
}

/**
 * Verify a JWT token
 */
export async function verifyToken(token: string): Promise<any> {
  try {
    // Check if token is blacklisted
    if (await isTokenBlacklisted(token)) {
      throw new Error("Token has been revoked");
    }

    // Verify token
    // Use any type to avoid TypeScript errors
    const jwtVerify: any = jwt.verify;
    return jwtVerify(token, JWT_SECRET_STRING);
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError) {
      if (error instanceof jwt.TokenExpiredError) {
        throw new Error("Invalid token");
      } else {
        throw new Error("Invalid token");
      }
    }

    throw error;
  }
}

/**
 * Decode a JWT token without verification
 * Useful for getting token metadata without verifying signature
 */
export function decodeToken(token: string): any {
  try {
    return jwt.decode(token);
  } catch (error) {
    console.error("Error decoding JWT token:", error);
    throw new Error("Failed to decode token");
  }
}

/**
 * Check if a token is about to expire
 * Returns true if token will expire within the specified threshold
 */
export function isTokenExpiringSoon(
  token: string,
  thresholdMinutes: number = 5,
): boolean {
  try {
    const decoded = jwt.decode(token) as { exp?: number };

    if (!decoded || !decoded.exp) {
      return true; // If we can't determine expiration, assume it's expiring soon
    }

    const expirationTime = decoded.exp * 1000; // Convert to milliseconds
    const currentTime = Date.now();
    const timeUntilExpiration = expirationTime - currentTime;

    return timeUntilExpiration < thresholdMinutes * 60 * 1000;
  } catch (error) {
    return true; // If there's an error, assume the token is expiring soon
  }
}

/**
 * Refresh a token if it's about to expire
 * Returns the original token if it's not expiring soon
 */
export function refreshTokenIfNeeded(
  token: string,
  thresholdMinutes: number = 5,
): string {
  try {
    if (isTokenExpiringSoon(token, thresholdMinutes)) {
      const decoded = jwt.decode(token) as Record<string, any>;

      // Remove standard JWT claims before regenerating
      const { iat, exp, nbf, jti, ...payload } = decoded;

      // Generate a new token with the same payload
      return generateToken(payload);
    }

    return token;
  } catch (error) {
    console.error("Error refreshing token:", error);
    throw new Error("Failed to refresh token");
  }
}

/**
 * Revoke a token by adding it to the blacklist (Redis-backed)
 */
export async function revokeToken(token: string): Promise<void> {
  try {
    const decoded = jwt.decode(token) as { exp?: number };

    if (!decoded || !decoded.exp) {
      throw new Error("Invalid token format");
    }

    const expiresAt = decoded.exp * 1000; // Convert to milliseconds
    const ttlSeconds = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));

    // Store in Redis with TTL matching token expiry (auto-cleanup)
    const tokenHash = Buffer.from(token).toString("base64").slice(0, 32);
    await setCache(`${BLACKLIST_KEY_PREFIX}${tokenHash}`, { revoked: true }, ttlSeconds);

    if (process.env.NODE_ENV === "production") {
      console.log(
        `Token revoked, will expire at ${new Date(expiresAt).toISOString()}`,
      );
    }
  } catch (error) {
    console.error("Error revoking token:", error);
    throw new Error("Failed to revoke token");
  }
}

/**
 * Check if a token is blacklisted (Redis-backed)
 */
export async function isTokenBlacklisted(token: string): Promise<boolean> {
  try {
    const tokenHash = Buffer.from(token).toString("base64").slice(0, 32);
    const result = await getCache<{ revoked: boolean }>(`${BLACKLIST_KEY_PREFIX}${tokenHash}`);
    return result?.revoked === true;
  } catch (error) {
    console.error("Error checking token blacklist:", error);
    return false; // Fail open to avoid blocking valid requests on cache errors
  }
}

/**
 * Extract token from Authorization header
 */
export function extractTokenFromHeader(
  authHeader: string | null,
): string | null {
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return null;
  }

  return authHeader.substring(7); // Remove "Bearer " prefix
}

/**
 * Get token statistics
 */
export function getTokenStats(): {
  blacklistStorage: string;
  jwtSecret: string;
  isUsingDefaultSecret: boolean;
} {
  return {
    blacklistStorage: "redis", // Now using Redis for distributed blacklist
    jwtSecret:
      JWT_SECRET_STRING.substring(0, 3) +
      "..." +
      JWT_SECRET_STRING.substring(JWT_SECRET_STRING.length - 3),
    isUsingDefaultSecret:
      JWT_SECRET_STRING === "your-jwt-secret-key-change-this-in-production",
  };
}
