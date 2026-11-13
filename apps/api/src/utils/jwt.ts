// The storefront's service JWT: minted by /auth/token for the holder of
// API_TOKEN (derived from SCALIUS_SECRET), HS256, for this API only (`aud`,
// `iss`), and valid for one hour from issue with no refresh: the verifier
// refuses a token older than that whatever its `exp` says, and the storefront
// mints a new one. There is no revocation list: anyone holding API_TOKEN can
// mint another token, so rotating SCALIUS_SECRET is the revocation, and it
// voids every token at once.
import jwt from "jsonwebtoken";

/** The only audience a service token is for: this API. */
export const SERVICE_TOKEN_AUDIENCE = "scalius-api";
/** Who mints service tokens: this API's /auth/token. */
export const SERVICE_TOKEN_ISSUER = "scalius-api/auth/token";
/** A service token's whole life, from issue. */
export const SERVICE_TOKEN_LIFETIME = "1h";
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
 * Sign a service token for this API. `expiresIn` may only shorten it: the
 * verifier refuses any token older than SERVICE_TOKEN_LIFETIME.
 */
export function generateToken(
  payload: Record<string, unknown>,
  expiresIn: string = SERVICE_TOKEN_LIFETIME,
  env?: JwtSigningEnv,
): string {
  try {
    const secret = getJwtSecret(env);
    return (jwt.sign as (...args: unknown[]) => string)(payload, secret, {
      algorithm: "HS256",
      expiresIn,
      audience: SERVICE_TOKEN_AUDIENCE,
      issuer: SERVICE_TOKEN_ISSUER,
    });
  } catch (error: unknown) {
    console.error("Error generating JWT token:", error);
    throw new Error("Failed to generate authentication token");
  }
}

/**
 * Verify a service token: signature (HS256 only), audience, issuer, expiry,
 * and an age within SERVICE_TOKEN_LIFETIME.
 */
export async function verifyToken(
  token: string,
  env: JwtSigningEnv,
): Promise<jwt.JwtPayload | string> {
  try {
    const secret = getJwtSecret(env);
    return (jwt.verify as (...args: unknown[]) => jwt.JwtPayload | string)(token, secret, {
      algorithms: ["HS256"],
      audience: SERVICE_TOKEN_AUDIENCE,
      issuer: SERVICE_TOKEN_ISSUER,
      maxAge: SERVICE_TOKEN_LIFETIME,
    });
  } catch (error: unknown) {
    if (error instanceof jwt.JsonWebTokenError) {
      throw new Error("Invalid token");
    }
    throw error;
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
