import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { generateToken, revokeToken, getTokenStats } from "../utils/jwt";
import { authMiddleware } from "../middleware/auth";
import { settings } from "@scalius/database/schema";
import { eq, and } from "drizzle-orm";
import { UnauthorizedError, ForbiddenError } from "../utils/api-error";
import { successEnvelope, messageResponse, errorResponses } from "../schemas/responses";

import { ok } from "../utils/api-response";
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
    result |= (viewA[i] ?? 0) ^ (viewB[i] ?? 0);
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
    200: {
      description: "Token generated",
      content: { "application/json": { schema: successEnvelope(z.object({ token: z.string() })) } },
    },
    ...errorResponses,
  },
});

app.openapi(getTokenRoute, async (c) => {
  const API_TOKEN = c.env.API_TOKEN;

  if (!API_TOKEN || API_TOKEN === "default-api-token-change-in-production") {
    // In production, refuse to issue system tokens with a missing or default secret
    console.error("API_TOKEN is not set or is using the insecure default value. Set it via `wrangler secret put API_TOKEN`.");
    throw new UnauthorizedError("Service token endpoint is not configured");
  }

  const apiToken = c.req.header("X-API-Token");

  if (!apiToken || !(await timingSafeCompare(apiToken, API_TOKEN))) {
    throw new UnauthorizedError("Invalid API token");
  }

  const token = generateToken({
    id: "system",
    email: "system@internal",
    name: "System Service",
    role: "system"
  }, undefined, c.env);

  return ok(c, { token });
});

// ─── GET /firebase-config ────────────────────────────────────────────────────

const firebaseConfigRoute = createRoute({
  method: "get",
  path: "/firebase-config",
  tags: ["Auth"],
  summary: "Get public Firebase config for client setup",
  responses: {
    200: {
      description: "Firebase config",
      content: { "application/json": { schema: successEnvelope(z.object({}).passthrough()) } },
    },
    ...errorResponses,
  },
});

app.openapi(firebaseConfigRoute, async (c) => {
  const db = c.get("db");
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

  return ok(c, config);
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
    200: {
      description: "Current user info",
      content: {
        "application/json": {
          schema: successEnvelope(z.object({
            user: z.object({
              id: z.string(),
              email: z.string(),
              name: z.string(),
              role: z.string(),
            }),
          })),
        },
      },
    },
    ...errorResponses,
  },
});

app.openapi(getMeRoute, (c) => {
  const user = c.get("user");
  return ok(c, { user });
});

// ─── POST /revoke ────────────────────────────────────────────────────────────

const revokeRoute = createRoute({
  method: "post",
  path: "/revoke",
  tags: ["Auth"],
  summary: "Revoke current token",
  responses: {
    200: {
      description: "Token revoked",
      content: { "application/json": { schema: messageResponse } },
    },
    ...errorResponses,
  },
});

app.openapi(revokeRoute, async (c) => {
  const authHeader = c.req.header("Authorization") || null;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new UnauthorizedError("No valid token provided");
  }

  const token = authHeader.substring(7);
  await revokeToken(token);

  return ok(c, {
    message: "Token revoked successfully"
  });
});

// ─── GET /token-stats ────────────────────────────────────────────────────────

const tokenStatsRoute = createRoute({
  method: "get",
  path: "/token-stats",
  tags: ["Auth"],
  summary: "Get token stats (admin/system only)",
  responses: {
    200: {
      description: "Token stats",
      content: { "application/json": { schema: successEnvelope(z.object({}).passthrough()) } },
    },
    ...errorResponses,
  },
});

app.openapi(tokenStatsRoute, (c) => {
  const user = c.get("user");

  if (user.role !== "admin" && user.role !== "system") {
    throw new ForbiddenError("You do not have permission to access this resource");
  }

  return ok(c, getTokenStats(c.env));
});

export default app;
