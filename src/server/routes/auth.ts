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

// Constant-time secret comparison — hash both values to SHA-256 then compare bytes
async function timingSafeCompare(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [hashA, hashB] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  const viewA = new Uint8Array(hashA);
  const viewB = new Uint8Array(hashB);
  if (viewA.length !== viewB.length) return false;
  let result = 0;
  for (let i = 0; i < viewA.length; i++) {
    result |= viewA[i] ^ viewB[i];
  }
  return result === 0;
}

// Create a Hono app with typed context
const app = new Hono<{
  Bindings: Env;
  Variables: {
    user: User;
  };
}>();

// Get token for service-to-service communication
app.get("/token", async (c) => {
  // Read API_TOKEN from Cloudflare Worker env bindings (c.env) first,
  // falling back to process.env for local dev compatibility.
  const API_TOKEN =
    c.env.API_TOKEN ||
    process.env.API_TOKEN ||
    "default-api-token-change-in-production";

  // Check if request has the correct API token
  const apiToken = c.req.header("X-API-Token");

  if (!apiToken || !(await timingSafeCompare(apiToken, API_TOKEN))) {
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
app.post("/revoke", async (c) => {
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

    // Revoke token (async - stores in Redis)
    await revokeToken(token);

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
