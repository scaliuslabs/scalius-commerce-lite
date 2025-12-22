import jwt from "jsonwebtoken";

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

// Token blacklist for revoked tokens
interface BlacklistedToken {
  token: string;
  expiresAt: number;
}

const blacklistedTokens: BlacklistedToken[] = [];

// Clean up expired blacklisted tokens periodically
setInterval(
  () => {
    const now = Date.now();
    const initialLength = blacklistedTokens.length;

    // Remove expired tokens
    while (
      blacklistedTokens.length > 0 &&
      blacklistedTokens[0].expiresAt < now
    ) {
      blacklistedTokens.shift();
    }

    // Log cleanup in production
    if (
      process.env.NODE_ENV === "production" &&
      initialLength !== blacklistedTokens.length
    ) {
      console.log(
        `Cleaned up ${initialLength - blacklistedTokens.length} expired blacklisted tokens`,
      );
    }
  },
  60 * 60 * 1000,
); // Clean up every hour

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
export function verifyToken(token: string): any {
  try {
    // Check if token is blacklisted
    if (isTokenBlacklisted(token)) {
      throw new Error("Token has been revoked");
    }

    // Verify token
    // Use any type to avoid TypeScript errors
    const jwtVerify: any = jwt.verify;
    return jwtVerify(token, JWT_SECRET_STRING);
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError) {
      if (error instanceof jwt.TokenExpiredError) {
        throw new Error("Token has expired");
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
 * Revoke a token by adding it to the blacklist
 */
export function revokeToken(token: string): void {
  try {
    const decoded = jwt.decode(token) as { exp?: number };

    if (!decoded || !decoded.exp) {
      throw new Error("Invalid token format");
    }

    const expiresAt = decoded.exp * 1000; // Convert to milliseconds

    // Add to blacklist
    blacklistedTokens.push({ token, expiresAt });

    // Sort blacklist by expiration time for efficient cleanup
    blacklistedTokens.sort((a, b) => a.expiresAt - b.expiresAt);

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
 * Check if a token is blacklisted
 */
export function isTokenBlacklisted(token: string): boolean {
  return blacklistedTokens.some(
    (blacklistedToken) => blacklistedToken.token === token,
  );
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
  blacklistedTokensCount: number;
  jwtSecret: string;
  isUsingDefaultSecret: boolean;
} {
  return {
    blacklistedTokensCount: blacklistedTokens.length,
    jwtSecret:
      JWT_SECRET_STRING.substring(0, 3) +
      "..." +
      JWT_SECRET_STRING.substring(JWT_SECRET_STRING.length - 3),
    isUsingDefaultSecret:
      JWT_SECRET_STRING === "your-jwt-secret-key-change-this-in-production",
  };
}
