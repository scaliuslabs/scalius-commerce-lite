// src/server/routes/abandoned-checkouts.ts
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { abandonedCheckouts } from "@scalius/database/schema";
import { eq } from "drizzle-orm";
import { authMiddleware } from "../middleware/auth";
import { getTrustedClientIp } from "../utils/client-ip";
import { isWithinRateLimit } from "../utils/rate-limit";
import { RateLimitError, ValidationError } from "../utils/api-error";
import { messageResponse, errorResponses } from "../schemas/responses";
import { abandonedCheckoutConsentBox, normalizeAbandonedCheckoutSnapshot, readAbandonedCheckoutConsentBox, readAbandonedCheckoutRecovery, saveAbandonedCheckoutSnapshot, verifyCheckoutRecoveryToken } from "@scalius/core/modules/checkout";
import { applyUnsubmittedCheckoutConsent } from "@scalius/core/modules/customer-marketing";
import { notificationSender } from "../background/notification-sender";
import { getCredentialEncryptionKey } from "../utils/encryption-key";
import { NotFoundError } from "../utils/api-error";
import { successEnvelope } from "../schemas/responses";

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
  const previousConsent = await readAbandonedCheckoutConsentBox(db, snapshot.checkoutId);
  await saveAbandonedCheckoutSnapshot(db, snapshot);
  // The consent box, ticked or unticked since the last save, on a checkout
  // not placed yet: the buyer's consent from that moment (COMMERCE-HOOKS H20).
  const ip = getTrustedClientIp(c);
  await applyUnsubmittedCheckoutConsent(db, {
    checkoutSessionId: snapshot.checkoutId,
    phone: snapshot.customerPhone,
    email: typeof snapshot.checkoutData.customerEmail === "string" ? snapshot.checkoutData.customerEmail : null,
    previous: previousConsent,
    current: abandonedCheckoutConsentBox(snapshot.checkoutData) ?? null,
  }, {
    env: c.env as never,
    send: notificationSender(c),
    ip,
    rateLimitKey: getCredentialEncryptionKey(c.env as unknown as Record<string, unknown>),
  });

  return ok(c, { message: "Abandoned checkout saved." });
});

// ─── POST /recover (a recovery link's lines) ─────────────────────────────────

const recoverRoute = createRoute({
  method: "post",
  path: "/recover",
  tags: ["Abandoned Checkouts"],
  summary: "Read the lines a checkout recovery link puts back in the cart",
  description: "The storefront's /cart/recover/{token} page posts the link's token (cr1.…) here. A valid, unexpired token of a checkout that still exists answers its lines (product, variant, quantity, title, slug) and market presence: no contact, no prices (the cart prices them again). Anything else is not found.",
  request: { body: { content: { "application/json": { schema: z.object({ token: z.string().min(1).max(200) }).strict() } } } },
  responses: {
    200: {
      description: "The checkout's lines",
      content: { "application/json": { schema: successEnvelope(z.object({
        presence: z.string().nullable(),
        lines: z.array(z.object({
          productId: z.string(),
          variantId: z.string().nullable(),
          quantity: z.number().int(),
          title: z.string(),
          slug: z.string().nullable(),
        })),
      })) } },
    },
    ...errorResponses,
  },
});

app.openapi(recoverRoute, async (c) => {
  if (!(await isWithinRateLimit(c.env, "RL_STANDARD", "checkout-recovery", getTrustedClientIp(c)))) {
    throw new RateLimitError("Too many requests. Please try again later.");
  }
  const verified = await verifyCheckoutRecoveryToken(c.env, c.req.valid("json").token, Math.floor(Date.now() / 1000));
  const recovery = verified ? await readAbandonedCheckoutRecovery(c.get("db"), verified.id) : null;
  // One answer for a bad, expired or spent link: it never says which.
  if (!recovery || recovery.lines.length === 0) throw new NotFoundError("This link has expired.");
  c.header("Cache-Control", "private, no-store");
  return ok(c, recovery);
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
