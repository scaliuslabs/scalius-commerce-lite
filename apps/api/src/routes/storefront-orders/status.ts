// Checkout status polling for in-flight and duplicate checkouts (derived cst_ tokens only).
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { orders, checkoutAttempts } from "@scalius/database/schema";
import { eq, sql } from "drizzle-orm";
import { getCheckoutAttemptRequestKeyFromStatusToken, isEndedCheckoutOrder } from "@scalius/core/modules/checkout";
import { ValidationError } from "../../utils/api-error";
import { ok } from "../../utils/api-response";
import { successEnvelope, errorResponses } from "../../schemas/responses";

const app = new OpenAPIHono<{ Bindings: Env }>();

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

  // Read both durable facts atomically.
  const attempt = await c.get("db")
    .select({
      status: checkoutAttempts.status,
      orderId: checkoutAttempts.orderId,
      persistedOrderId: orders.id,
      orderStatus: sql<string | null>`${orders.status}`.as("order_status"),
      deletedAt: orders.deletedAt,
      paymentStatus: orders.paymentStatus,
      paidAmountMinor: orders.paidAmountMinor,
    })
    .from(checkoutAttempts)
    .leftJoin(orders, eq(orders.id, checkoutAttempts.orderId))
    .where(eq(checkoutAttempts.requestKey, requestKey))
    .get();

  if (attempt?.persistedOrderId) {
    if (isEndedCheckoutOrder({
      id: attempt.persistedOrderId,
      status: attempt.orderStatus,
      deletedAt: attempt.deletedAt,
      paymentStatus: attempt.paymentStatus,
      paidAmountMinor: attempt.paidAmountMinor,
    })) {
      return ok(c, {
        status: "expired",
        orderId: attempt.orderId,
        error: "This unpaid checkout expired. Please review your cart and try again.",
      });
    }

    if (attempt.deletedAt === null) {
      return ok(c, { status: "completed", orderId: attempt.orderId });
    }
  } else if (attempt?.status === "failed") {
    const error = "Order creation failed. Please review your checkout and try again.";
    return ok(c, { status: "failed", orderId: attempt.orderId, error });
  }

  // Missing rows and expired processing leases do not prove a commit failed.
  return c.json({
    success: true,
    data: {
      status: "processing",
      ...(attempt ? { orderId: attempt.orderId } : {}),
      message: "Order is processing.",
    },
  }, 202);
});

export { app as checkoutStatusRoutes };
