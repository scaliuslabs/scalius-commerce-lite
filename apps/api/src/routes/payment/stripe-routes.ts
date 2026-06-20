// src/server/routes/payment/stripe-routes.ts
// Hono routes for Stripe payment operations.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { validateReceiptToken } from "../../utils/order-receipt-token";
import { successEnvelope, errorResponses, serviceUnavailableResponse } from "../../schemas/responses";
import { ok } from "../../utils/api-response";
import { createStripePaymentSession } from "./payment-session-create";

const app = new OpenAPIHono<{ Bindings: Env }>();

// ─── POST /intent ────────────────────────────────────────────────────────────

const intentSchema = z.object({
  orderId: z.string().min(1),
  receiptToken: z.string().min(1),
  paymentType: z.enum(["full", "deposit", "balance"]).optional(),
  depositAmount: z.number().positive().optional(),
  currency: z.string().length(3).optional(),
  manualCapture: z.boolean().default(false)
});

const createIntentRoute = createRoute({
  method: "post",
  path: "/intent",
  tags: ["Payments - Stripe"],
  summary: "Create a Stripe PaymentIntent for an order",
  request: {
    body: {
      content: {
        "application/json": { schema: intentSchema }
      }
    }
  },
  responses: {
    200: {
      description: "PaymentIntent created",
      content: {
        "application/json": {
          schema: successEnvelope(z.object({
            clientSecret: z.string().optional(),
            paymentIntentId: z.string().optional(),
            publishableKey: z.string(),
            amount: z.number(),
            currency: z.string(),
          })),
        },
      },
    },
    ...errorResponses,
    503: serviceUnavailableResponse,
  },
});

app.openapi(createIntentRoute, async (c) => {
  const db = c.get("db");
  const body = c.req.valid("json");
  await validateReceiptToken(c.env.CACHE, body.orderId, body.receiptToken, db);

  const result = await createStripePaymentSession(c, {
    orderId: body.orderId,
    paymentType: body.paymentType,
    depositAmount: body.depositAmount,
    proof: { kind: "receipt", receiptToken: body.receiptToken },
    returnTarget: { kind: "receipt", receiptToken: body.receiptToken },
  });

  return ok(c, result.stripe);
});

export const stripePaymentRoutes = app;
