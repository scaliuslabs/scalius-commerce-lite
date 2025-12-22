import type { MiddlewareHandler } from "hono";
import {
  extractTokenFromHeader,
  verifyToken,
  refreshTokenIfNeeded,
} from "../utils/jwt";

// Define the user type for type safety
interface User {
  id: string;
  email: string;
  name: string;
  role: string;
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

  try {
    // Get authorization header
    const authHeader = c.req.header("Authorization") || null;

    // Extract token from header
    const token = extractTokenFromHeader(authHeader);

    if (!token) {
      return c.json(
        {
          success: false,
          error: "Authentication required",
          message: "Please provide a valid authentication token",
        },
        401,
      );
    }

    try {
      // Verify token
      const decoded = verifyToken(token) as User;

      // Store user info in context
      c.set("user", decoded);

      // Check if token needs to be refreshed
      const refreshedToken = refreshTokenIfNeeded(token);

      // If token was refreshed, set new token in response header
      if (refreshedToken !== token) {
        c.header("X-New-Token", refreshedToken);
      }

      // Continue to next middleware/handler
      await next();
    } catch (error) {
      // Handle specific token errors
      if (error instanceof Error) {
        if (error.message === "Token has expired") {
          return c.json(
            {
              success: false,
              error: "Token expired",
              message:
                "Your authentication token has expired. Please log in again.",
            },
            401,
          );
        } else if (error.message === "Token has been revoked") {
          return c.json(
            {
              success: false,
              error: "Token revoked",
              message:
                "Your authentication token has been revoked. Please log in again.",
            },
            401,
          );
        } else if (error.message === "Invalid token") {
          return c.json(
            {
              success: false,
              error: "Invalid token",
              message:
                "The provided authentication token is invalid. Please log in again.",
            },
            401,
          );
        }
      }

      // Generic auth error
      return c.json(
        {
          success: false,
          error: "Authentication failed",
          message:
            error instanceof Error
              ? error.message
              : "Unknown authentication error",
        },
        401,
      );
    }
  } catch (error) {
    // Log unexpected errors in production
    if (process.env.NODE_ENV === "production") {
      console.error("Auth middleware error:", error);
    }

    // Return generic error
    return c.json(
      {
        success: false,
        error: "Server error",
        message: "An unexpected error occurred during authentication",
      },
      500,
    );
  }
};
