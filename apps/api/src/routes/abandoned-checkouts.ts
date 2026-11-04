// src/server/routes/abandoned-checkouts.ts
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { abandonedCheckouts } from "@scalius/database/schema";
import { eq } from "drizzle-orm";
import { authMiddleware } from "../middleware/auth";
import { getTrustedClientIp } from "../utils/client-ip";
import { isWithinRateLimit } from "../utils/rate-limit";
import { RateLimitError, ValidationError } from "../utils/api-error";
import { messageResponse, errorResponses } from "../schemas/responses";
import { normalizeAbandonedCheckoutSnapshot, saveAbandonedCheckoutSnapshot } from "@scalius/core/modules/checkout";

import { ok } from "../utils/api-response";
const app = new OpenAPIHono<{ Bindings: Env }>();

// ─── POST / (Create or Update) ──────────────────────────────────────────────

const abandonedCheckoutSchema = z.object({
  checkoutId: z.string().min(1, "checkoutId is required"),
  customerPhone: z.string().optional(),
  checkoutData: z.record(z.string(), z.unknown()).openapi({ description: "Checkout data (arbitrary JSON)" })
});

const saveAbandonedCheckoutRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Abandoned Checkouts"],
  summary: "Save or update an abandoned checkout",
  request: {
    body: {
      content: {
        "application/json": { schema: abandonedCheckoutSchema }
      }
    }
  },
  responses: {
    200: {
      description: "Abandoned checkout saved",
      content: { "application/json": { schema: messageResponse } },
    },
    ...errorResponses,
  },
});

app.openapi(saveAbandonedCheckoutRoute, async (c) => {
  // The storefront saves a debounced snapshot as the buyer fills each checkout
  // field, so one buyer legitimately sends several saves a minute.
  if (!(await isWithinRateLimit(c.env, "RL_STANDARD", "abandoned-checkout", getTrustedClientIp(c)))) {
    throw new RateLimitError("Too many requests. Please try again later.");
  }

  const db = c.get("db");
  const input = c.req.valid("json");
  let snapshot: ReturnType<typeof normalizeAbandonedCheckoutSnapshot>;
  try {
    snapshot = normalizeAbandonedCheckoutSnapshot(input);
  } catch (error) {
    throw new ValidationError(error instanceof Error ? error.message : "Invalid checkout snapshot");
  }
  // A session that already placed its order writes nothing; the answer is the
  // same either way, so the public route never says whether an order exists.
  await saveAbandonedCheckoutSnapshot(db, snapshot);

  return ok(c, { message: "Abandoned checkout saved." });
});

// ─── POST /cleanup ───────────────────────────────────────────────────────────

const cleanupSchema = z.object({
  checkoutId: z.string().min(1, "checkoutId is required for cleanup")
});

const cleanupRoute = createRoute({
  method: "post",
  path: "/cleanup",
  tags: ["Abandoned Checkouts"],
  summary: "Delete abandoned checkout after successful order",
  request: {
    body: {
      content: {
        "application/json": { schema: cleanupSchema }
      }
    }
  },
  responses: {
    200: {
      description: "Abandoned checkout cleaned up",
      content: { "application/json": { schema: messageResponse } },
    },
    ...errorResponses,
  },
});

// Auth middleware for cleanup
app.use("/cleanup", authMiddleware);

app.openapi(cleanupRoute, async (c) => {
  const db = c.get("db");
  const { checkoutId } = c.req.valid("json");

  await db
    .delete(abandonedCheckouts)
    .where(eq(abandonedCheckouts.checkoutId, checkoutId));

  return ok(c, {
    message: `Abandoned checkout record ${checkoutId} deleted.`
  });
});

export { app as abandonedCheckoutsRoutes };
