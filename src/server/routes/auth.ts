import { Hono } from "hono";
import { generateToken, revokeToken, getTokenStats } from "../utils/jwt";
import { authMiddleware } from "../middleware/auth";

// Define the user type for type safety
interface User {
  id: string;
  email: string;
  name: string;
  role: string;
}

// Create a Hono app with typed context
const app = new Hono<{
  Variables: {
    user: User;
  };
}>();

// System API token for service-to-service communication
const API_TOKEN =
  process.env.API_TOKEN || "default-api-token-change-in-production";

// Check if we're in production and warn about insecure API token
if (
  process.env.NODE_ENV === "production" &&
  API_TOKEN === "default-api-token-change-in-production"
) {
  console.warn(
    "WARNING: Using default API token in production. This is insecure. Set API_TOKEN environment variable.",
  );
}

// Get token for service-to-service communication
app.get("/token", (c) => {
  // Check if request has the correct API token
  const apiToken = c.req.header("X-API-Token");

  if (apiToken !== API_TOKEN) {
    return c.json(
      {
        success: false,
        error: "Unauthorized",
        message: "Invalid API token",
      },
      401,
    );
  }

  // Generate JWT token for service
  const token = generateToken({
    id: "system",
    email: "system@scalius.com",
    name: "System Service",
    role: "system",
  });

  return c.json({
    success: true,
    data: {
      token,
    },
  });
});

// Apply auth middleware to all routes below
app.use("/*", authMiddleware);

// Get current user/service info
app.get("/me", (c) => {
  const user = c.get("user");

  return c.json({
    success: true,
    data: {
      user,
    },
  });
});

// Revoke current token
app.post("/revoke", (c) => {
  try {
    // Get authorization header
    const authHeader = c.req.header("Authorization") || null;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return c.json(
        {
          success: false,
          error: "Invalid token",
          message: "No valid token provided",
        },
        400,
      );
    }

    const token = authHeader.substring(7);

    // Revoke token
    revokeToken(token);

    return c.json({
      success: true,
      message: "Token revoked successfully",
    });
  } catch (error) {
    console.error("Token revocation error:", error);

    return c.json(
      {
        success: false,
        error: "Server error",
        message: "An unexpected error occurred during token revocation",
      },
      500,
    );
  }
});

// Get token stats (admin/system only)
app.get("/token-stats", (c) => {
  const user = c.get("user");

  // Check if user is admin or system
  if (user.role !== "admin" && user.role !== "system") {
    return c.json(
      {
        success: false,
        error: "Unauthorized",
        message: "You do not have permission to access this resource",
      },
      403,
    );
  }

  return c.json({
    success: true,
    data: getTokenStats(),
  });
});

// Test endpoint to verify auth routes are working
app.get("/test", (c) => {
  return c.json({
    success: true,
    message: "Auth routes are working correctly",
    user: c.get("user"),
  });
});

export default app;
