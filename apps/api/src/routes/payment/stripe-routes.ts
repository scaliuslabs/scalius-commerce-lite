// src/server/routes/payment/stripe-routes.ts
// Hono routes for Stripe payment operations.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Database } from "@scalius/database/client";
import { validateReceiptToken } from "../../utils/order-receipt-token";
import { successEnvelope, errorResponses, serviceUnavailableResponse } from "../../schemas/responses";
import { ok } from "../../utils/api-response";
import { createStripePaymentSession, isPaymentSessionProcessingResult } from "./payment-session-create";
import { acceptedPaymentSessionProcessing, paymentSessionProcessingResponse } from "./payment-session-response";
import { reconcileStripeOrderPayment } from "./stripe-reconciliation";

const app = new OpenAPIHono<{ Bindings: Env }>();
const RECEIPT_TOKEN_HEADER = "X-Receipt-Token";

// ─── POST /intent ────────────────────────────────────────────────────────────

const intentSchema = z.object({
  orderId: z.string().min(1),
  receiptToken: z.string().min(1).optional(),
  paymentType: z.enum(["full", "deposit", "balance"]).optional(),
  depositAmount: z.number().positive().optional(),
  currency: z.string().length(3).optional(),
  manualCapture: z.boolean().default(false),
  replaceExistingAttempt: z.boolean().optional(),
});

function getReceiptToken(c: { req: { header: (name: string) => string | undefined } }, body: { receiptToken?: string }): string | undefined {
  const headerToken = c.req.header(RECEIPT_TOKEN_HEADER)?.trim();
  return body.receiptToken ?? (headerToken || undefined);
}

async function validateReceiptProof(
  c: { env: Env; req: { header: (name: string) => string | undefined } },
  db: Database,
  body: { orderId: string; receiptToken?: string },
): Promise<string> {
  const receiptToken = getReceiptToken(c, body);
  await validateReceiptToken(c.env.CACHE, body.orderId, receiptToken, db);
  if (!receiptToken) throw new Error("Receipt token validation returned without proof.");
  return receiptToken;
}

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
    },
    headers: z.object({
      [RECEIPT_TOKEN_HEADER]: z.string().optional(),
    }),
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
    202: paymentSessionProcessingResponse,
    ...errorResponses,
    503: serviceUnavailableResponse,
  },
});

app.openapi(createIntentRoute, async (c) => {
  const db = c.get("db");
  const body = c.req.valid("json");
  const receiptToken = await validateReceiptProof(c, db, body);

  const result = await createStripePaymentSession(c, {
    orderId: body.orderId,
    paymentType: body.paymentType,
    depositAmount: body.depositAmount,
    replaceExistingAttempt: body.replaceExistingAttempt,
    proof: { kind: "receipt", receiptToken },
    returnTarget: { kind: "receipt" },
  });

  if (isPaymentSessionProcessingResult(result)) {
    return acceptedPaymentSessionProcessing(c, result);
  }

  return ok(c, result.stripe);
});

// ─── POST /reconcile ────────────────────────────────────────────────────────

const reconcileSchema = z.object({
  orderId: z.string().min(1),
  receiptToken: z.string().min(1).optional(),
});

const reconcileResultSchema = z.object({
  status: z.enum(["pending", "scheduled", "settled"]),
  providerStatus: z.string().nullable(),
});

const reconcileRoute = createRoute({
  method: "post",
  path: "/reconcile",
  tags: ["Payments - Stripe"],
  summary: "Verify and reconcile a Stripe payment for a private order receipt",
  request: {
    body: {
      content: {
        "application/json": { schema: reconcileSchema },
      },
    },
    headers: z.object({
      [RECEIPT_TOKEN_HEADER]: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "Payment is pending or already settled",
      content: { "application/json": { schema: successEnvelope(reconcileResultSchema) } },
    },
    202: {
      description: "Confirmed provider payment was scheduled for settlement",
      content: { "application/json": { schema: successEnvelope(reconcileResultSchema) } },
    },
    ...errorResponses,
    503: serviceUnavailableResponse,
  },
});

app.openapi(reconcileRoute, async (c) => {
  const db = c.get("db");
  const body = c.req.valid("json");
  await validateReceiptProof(c, db, body);

  const { data, accepted } = await reconcileStripeOrderPayment({ db, env: c.env, orderId: body.orderId });
  return accepted
    ? c.json({ success: true as const, data }, 202)
    : ok(c, data);
});

export const stripePaymentRoutes = app;
