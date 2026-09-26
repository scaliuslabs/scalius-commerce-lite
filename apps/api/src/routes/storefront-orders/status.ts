// Checkout status polling for in-flight and duplicate checkouts (derived cst_ tokens only).
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { orders, checkoutAttempts } from "@scalius/database/schema";
import { eq } from "drizzle-orm";
import { getCheckoutAttemptRequestKeyFromStatusToken } from "@scalius/core/modules/checkout";
import { getOptionalExecutionContext } from "../../utils/execution-context";
import { ValidationError } from "../../utils/api-error";
import { getCheckoutStatusKvKey } from "../../utils/order-receipt-token";
import { ok } from "../../utils/api-response";
import { successEnvelope, errorResponses } from "../../schemas/responses";
import { scheduleCheckoutSuccessRecoveryHints, scheduleCheckoutFailureStatusHint } from "./shared";

const app = new OpenAPIHono<{ Bindings: Env }>();

type CheckoutStatusResponsePayload = {
  status: string;
  orderId?: string;
  error?: string;
  message?: string;
};

function sanitizeCheckoutStatusPayload(value: unknown): CheckoutStatusResponsePayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { status: "processing" };
  }

  const record = value as Record<string, unknown>;
  const safePayload: CheckoutStatusResponsePayload = {
    status: typeof record.status === "string" ? record.status : "processing",
  };
  if (typeof record.orderId === "string") {
    safePayload.orderId = record.orderId;
  }
  if (typeof record.error === "string") {
    safePayload.error = record.error;
  }
  if (typeof record.message === "string") {
    safePayload.message = record.message;
  }

  return safePayload;
}

// ─── GET /status/:token ──────────────────────────────────────────────────────

const getOrderStatusRoute = createRoute({
  method: "get",
  path: "/status/{token}",
  tags: ["Orders"],
  summary: "Check order processing status by status token",
  request: {
    params: z.object({
      token: z.string(),
    }),
  },
  responses: {
    200: {
      description: "Order status",
      content: { "application/json": { schema: successEnvelope(z.object({
        status: z.string(),
        orderId: z.string().optional(),
        error: z.string().optional(),
        message: z.string().optional(),
      })) } },
    },
    202: {
      description: "Order is processing",
      content: { "application/json": { schema: z.object({
        success: z.literal(true),
        data: z.object({
          status: z.string(),
          message: z.string(),
          orderId: z.string().optional(),
        }),
      }) } },
    },
    400: errorResponses[400],
  }
});

app.openapi(getOrderStatusRoute, async (c) => {
  const statusToken = c.req.valid("param").token;
  c.header("Cache-Control", "no-cache, no-store, must-revalidate");
  c.header("Pragma", "no-cache");
  c.header("Expires", "0");

  const requestKey = getCheckoutAttemptRequestKeyFromStatusToken(statusToken);
  if (!requestKey) {
    throw new ValidationError("Invalid checkout status token");
  }

  if (!c.env.CACHE) {
    console.warn("[Orders] Polling endpoint hit but CACHE KV is not bound!");
    return ok(c, { status: "processing" });
  }

  const kvKey = await getCheckoutStatusKvKey(statusToken);
  const statusStr = await c.env.CACHE.get(kvKey);

  if (!statusStr) {
    const db = c.get("db");
    const attempt = await db
      .select({
        status: checkoutAttempts.status,
        orderId: checkoutAttempts.orderId,
        checkoutToken: checkoutAttempts.checkoutToken,
        lastError: checkoutAttempts.lastError,
      })
      .from(checkoutAttempts)
      .where(eq(checkoutAttempts.requestKey, requestKey))
      .get();

    if (attempt?.status === "committed") {
      scheduleCheckoutSuccessRecoveryHints(
        c.env,
        statusToken,
        attempt.checkoutToken,
        attempt.orderId,
        getOptionalExecutionContext(c),
      );
      return ok(c, {
        status: "completed",
        orderId: attempt.orderId,
      });
    }

    if (attempt?.status === "failed") {
      scheduleCheckoutFailureStatusHint(
        c.env,
        statusToken,
        attempt.orderId,
        attempt.lastError || "Order creation failed. Please try again.",
        getOptionalExecutionContext(c),
      );
      return ok(c, {
        status: "failed",
        orderId: attempt.orderId,
        error: attempt.lastError || "Order creation failed. Please try again.",
      });
    }

    if (attempt?.status === "processing") {
      const orderExists = await db
        .select({ id: orders.id })
        .from(orders)
        .where(eq(orders.id, attempt.orderId))
        .get();

      if (orderExists) {
        scheduleCheckoutSuccessRecoveryHints(
          c.env,
          statusToken,
          attempt.checkoutToken,
          attempt.orderId,
          getOptionalExecutionContext(c),
        );
        return ok(c, {
          status: "completed",
          orderId: attempt.orderId,
        });
      }

      return c.json({
        success: true,
        data: {
          status: "processing",
          orderId: attempt.orderId,
          message: "Order is processing.",
        },
      }, 202);
    }

    return c.json({ success: true, data: { status: "processing", message: "Order is waiting in queue." } }, 202);
  }

  const statusData = JSON.parse(statusStr);

  if (statusData.status === "processing" && statusData.orderId) {
    const db = c.get("db");
    const [attempt, orderExists] = await Promise.all([
      db
        .select({
          status: checkoutAttempts.status,
          orderId: checkoutAttempts.orderId,
          checkoutToken: checkoutAttempts.checkoutToken,
          lastError: checkoutAttempts.lastError,
        })
        .from(checkoutAttempts)
        .where(eq(checkoutAttempts.requestKey, requestKey))
        .get(),
      db
        .select({ id: orders.id })
        .from(orders)
        .where(eq(orders.id, statusData.orderId))
        .limit(1),
    ]);

    if (attempt?.status === "failed") {
      scheduleCheckoutFailureStatusHint(
        c.env,
        statusToken,
        attempt.orderId,
        attempt.lastError || "Order creation failed. Please try again.",
        getOptionalExecutionContext(c),
      );
      return ok(c, {
        status: "failed",
        orderId: attempt.orderId,
        error: attempt.lastError || "Order creation failed. Please try again.",
      });
    }

    if (attempt && orderExists.length > 0) {
      scheduleCheckoutSuccessRecoveryHints(
        c.env,
        statusToken,
        attempt.checkoutToken,
        attempt.orderId,
        getOptionalExecutionContext(c),
      );
      return ok(c, {
        status: "completed",
        orderId: attempt.orderId,
      });
    }
  }

  return ok(c, sanitizeCheckoutStatusPayload(statusData));
});

export { app as checkoutStatusRoutes };
