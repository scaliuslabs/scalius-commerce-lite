import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { generateToken, revokeToken, getTokenStats } from "../utils/jwt";
import { authMiddleware } from "../middleware/auth";
import { db } from "@scalius/database/client";
import { settings } from "@scalius/database/schema";
import { eq, and } from "drizzle-orm";
import { UnauthorizedError, ForbiddenError } from "../utils/api-error";

// Define the user type for type safety
interface User {
  id: string;
  email: string;
  name: string;
  role: string;
}

// Constant-time secret comparison
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

const app = new OpenAPIHono<{
  Bindings: Env;
  Variables: {
    user: User;
  };
}>();

// ─── GET /token ──────────────────────────────────────────────────────────────

const getTokenRoute = createRoute({
  method: "get",
  path: "/token",
  tags: ["Auth"],
  summary: "Get JWT token for service-to-service communication",
  responses: {
    200: { description: "Token generated", content: { "application/json": { schema: z.any() } } },
    401: { description: "Unauthorized", content: { "application/json": { schema: z.any() } } },
  },
});

app.openapi(getTokenRoute, async (c) => {
  const API_TOKEN =
    c.env.API_TOKEN ||
    process.env.API_TOKEN ||
    "default-api-token-change-in-production";

  const apiToken = c.req.header("X-API-Token");

  if (!apiToken || !(await timingSafeCompare(apiToken, API_TOKEN))) {
    throw new UnauthorizedError("Invalid API token");
  }

  const token = generateToken({
    id: "system",
    email: "system@internal",
    name: "System Service",
    role: "system",
  });

  return c.json({
    success: true,
    data: { token },
  }, 200);
});

// ─── GET /firebase-config ────────────────────────────────────────────────────

const firebaseConfigRoute = createRoute({
  method: "get",
  path: "/firebase-config",
  tags: ["Auth"],
  summary: "Get public Firebase config for client setup",
  responses: {
    200: { description: "Firebase config", content: { "application/json": { schema: z.any() } } },
  },
});

app.openapi(firebaseConfigRoute, async (c) => {
  const result = await db
    .select({ value: settings.value })
    .from(settings)
    .where(
      and(
        eq(settings.key, "public_config"),
        eq(settings.category, "firebase"),
      ),
    )
    .get();

  let config = {};
  if (result && result.value) {
    config = JSON.parse(result.value);
  }

  return c.json(config, 200);
});

// Apply auth middleware to all routes below
app.use("/*", authMiddleware);

// ─── GET /me ─────────────────────────────────────────────────────────────────

const getMeRoute = createRoute({
  method: "get",
  path: "/me",
  tags: ["Auth"],
  summary: "Get current user/service info",
  responses: {
    200: { description: "Current user info", content: { "application/json": { schema: z.any() } } },
  },
});

app.openapi(getMeRoute, (c) => {
  const user = c.get("user");
  return c.json({
    success: true,
    data: { user },
  }, 200);
});

// ─── POST /revoke ────────────────────────────────────────────────────────────

const revokeRoute = createRoute({
  method: "post",
  path: "/revoke",
  tags: ["Auth"],
  summary: "Revoke current token",
  responses: {
    200: { description: "Token revoked", content: { "application/json": { schema: z.any() } } },
    400: { description: "Invalid token", content: { "application/json": { schema: z.any() } } },
  },
});

app.openapi(revokeRoute, async (c) => {
  const authHeader = c.req.header("Authorization") || null;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return c.json({
      success: false,
      error: "Invalid token",
      message: "No valid token provided",
    }, 400);
  }

  const token = authHeader.substring(7);
  await revokeToken(token);

  return c.json({
    success: true,
    message: "Token revoked successfully",
  }, 200);
});

// ─── GET /token-stats ────────────────────────────────────────────────────────

const tokenStatsRoute = createRoute({
  method: "get",
  path: "/token-stats",
  tags: ["Auth"],
  summary: "Get token stats (admin/system only)",
  responses: {
    200: { description: "Token stats", content: { "application/json": { schema: z.any() } } },
    403: { description: "Forbidden", content: { "application/json": { schema: z.any() } } },
  },
});

app.openapi(tokenStatsRoute, (c) => {
  const user = c.get("user");

  if (user.role !== "admin" && user.role !== "system") {
    throw new ForbiddenError("You do not have permission to access this resource");
  }

  return c.json({
    success: true,
    data: getTokenStats(),
  }, 200);
});

export default app;
