import type { MiddlewareHandler } from "hono";
import {
  extractTokenFromHeader,
  verifyToken,
  refreshTokenIfNeeded,
} from "../utils/jwt";
import { AppError, UnauthorizedError } from "../utils/api-error";

// Define the user type for type safety
interface User {
  id: string;
  email: string;
  name: string;
  role: string;
  [key: string]: unknown;
}

/**
 * Authentication middleware for Hono
 * Verifies JWT tokens and refreshes them if needed
 */
export const authMiddleware: MiddlewareHandler = async (c, next) => {
  // Skip auth for health check endpoint
  if (c.req.path === "/health") {
    return next();
  }

  // Skip auth for Swagger UI and OpenAPI JSON
  if (c.req.path === "/docs" || c.req.path === "/openapi.json") {
    return next();
  }

  // Also skip for the /auth/token endpoint
  if (c.req.path === "/auth/token") {
    return next();
  }

  // Get authorization header
  const authHeader = c.req.header("Authorization") || null;

  // Extract token from header
  const token = extractTokenFromHeader(authHeader);

  if (!token) {
    throw new UnauthorizedError("Authentication required");
  }

  try {
    // Verify token against the shared KV revocation list.
    const decoded = (await verifyToken(token, { JWT_SECRET: c.env.JWT_SECRET, CACHE: c.env.CACHE })) as User;

    // Store user info in context
    c.set("user", decoded);

    // Check if token needs to be refreshed
    const refreshedToken = await refreshTokenIfNeeded(
      token,
      { JWT_SECRET: c.env.JWT_SECRET, CACHE: c.env.CACHE },
      5,
    );

    // If token was refreshed, set new token in response header
    if (refreshedToken !== token) {
      c.header("X-New-Token", refreshedToken);
    }

    // Continue to next middleware/handler
    await next();
  } catch (error: unknown) {
    if (error instanceof AppError) throw error;
    // SECURITY: Use generic error message to prevent token enumeration
    throw new UnauthorizedError("Invalid or expired token");
  }
};
