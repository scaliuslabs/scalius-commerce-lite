// The storefront's service JWT: minted by /auth/token for the holder of
// API_TOKEN (derived from SCALIUS_SECRET) and valid for one hour. There is no
// revocation list: anyone holding API_TOKEN can mint another token, so
// rotating SCALIUS_SECRET is the revocation, and it voids every token at once.
import jwt from "jsonwebtoken";

// Default JWT expiration time (1 hour)
const DEFAULT_EXPIRATION = "1h";

interface JwtSigningEnv {
  JWT_SECRET?: string;
  [key: string]: unknown;
}

/**
 * Read the JWT signing secret from the request-scoped env. The value is
 * derived from `SCALIUS_SECRET` at Worker entry (src/runtime/runtime-env.ts);
 * there is no process.env or default-secret fallback.
 */
function getJwtSecret(env?: JwtSigningEnv): string {
  const secret = env?.JWT_SECRET;
  if (typeof secret !== "string" || secret.length === 0) {
    throw new Error("JWT_SECRET is not available in the runtime env");
  }
  return secret;
}

/**
 * Generate a JWT token.
 */
export function generateToken(
  payload: Record<string, unknown>,
  expiresIn: string = DEFAULT_EXPIRATION,
  env?: JwtSigningEnv,
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
 * Verify a JWT token's signature and expiry.
 */
export async function verifyToken(
  token: string,
  env: JwtSigningEnv,
): Promise<jwt.JwtPayload | string> {
  try {
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
 * Verifies the token signature before re-signing to prevent forged token escalation.
 */
export async function refreshTokenIfNeeded(
  token: string,
  env: JwtSigningEnv,
  thresholdMinutes = 5,
): Promise<string> {
  try {
    if (isTokenExpiringSoon(token, thresholdMinutes)) {
      // Verify signature first — never re-sign an unverified token
      const verified = await verifyToken(token, env);
      const { iat: _iat, exp: _exp, nbf: _nbf, jti: _jti, ...payload } = verified as Record<string, unknown>;
      return generateToken(payload, DEFAULT_EXPIRATION, env);
    }
    return token;
  } catch (error: unknown) {
    console.error("Error refreshing token:", error);
    throw new Error("Failed to refresh token");
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
