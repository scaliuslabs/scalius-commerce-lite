// src/server/routes/abandoned-checkouts.ts
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { abandonedCheckouts } from "@scalius/database/schema";
import { eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { authMiddleware } from "../middleware/auth";
import { rateLimit, getClientIp } from "@scalius/shared/rate-limit";
import { RateLimitError } from "../utils/api-error";
import { messageResponse, errorResponses } from "../schemas/responses";

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
  // Rate limit: 10 abandoned checkout saves per minute per IP
  const kv = (c.env as Record<string, unknown>).CACHE as KVNamespace | undefined;
  if (kv) {
    const ip = getClientIp(c.req.raw);
    const result = await rateLimit({ kv, key: `abandoned:${ip}`, limit: 10, windowMs: 60_000 });
    if (!result.allowed) {
      throw new RateLimitError("Too many requests. Please try again later.");
    }
  }

  const db = c.get("db");
  const { checkoutId, customerPhone, checkoutData } = c.req.valid("json");
  const checkoutDataString = JSON.stringify(checkoutData);

  const existingCheckout = await db
    .select({ id: abandonedCheckouts.id })
    .from(abandonedCheckouts)
    .where(eq(abandonedCheckouts.checkoutId, checkoutId))
    .get();

  if (existingCheckout) {
    await db
      .update(abandonedCheckouts)
      .set({
        customerPhone: customerPhone,
        checkoutData: checkoutDataString,
        updatedAt: sql`(cast(strftime('%s','now') as int))`
      })
      .where(eq(abandonedCheckouts.id, existingCheckout.id));
  } else {
    await db.insert(abandonedCheckouts).values({
      id: `ab_ch_${nanoid()}`,
      checkoutId: checkoutId,
      customerPhone: customerPhone,
      checkoutData: checkoutDataString,
      createdAt: sql`(cast(strftime('%s','now') as int))`,
      updatedAt: sql`(cast(strftime('%s','now') as int))`
    });
  }

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
