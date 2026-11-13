import type { MiddlewareHandler } from "hono";
import { extractTokenFromHeader, verifyToken } from "../utils/jwt";
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
 * Service authentication for the storefront's API calls: a valid service JWT
 * (utils/jwt.ts). Tokens are never refreshed here; the storefront mints a new
 * one from /auth/token when its token nears the end of its hour.
 */
export const authMiddleware: MiddlewareHandler = async (c, next) => {
  // Skip auth for health check endpoint
  if (c.req.path === "/health") {
    return next();
  }

  // Skip auth for the OpenAPI JSON
  if (c.req.path === "/openapi.json") {
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
    const decoded = (await verifyToken(token, { JWT_SECRET: c.env.JWT_SECRET })) as User;

    // Store user info in context
    c.set("user", decoded);

    // Continue to next middleware/handler
    await next();
  } catch (error: unknown) {
    if (error instanceof AppError) throw error;
    // SECURITY: Use generic error message to prevent token enumeration
    throw new UnauthorizedError("Invalid or expired token");
  }
};
