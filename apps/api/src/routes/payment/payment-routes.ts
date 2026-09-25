// Public payment routes for every gateway, mounted at /payment:
//   POST /{provider}/session    create (or replay) a buyer payment session
//   POST /{provider}/reconcile  ask the provider whether the session was captured
//   GET|POST /{provider}/success|fail|cancel  hosted-gateway buyer returns

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { eq } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import { orders } from "@scalius/database/schema";
import {
  getPaymentGateway,
  reconcileHostedPaymentReturn,
  type HostedPaymentReturnResult,
  parsePaymentCorrelationId,
  type GatewayRequest,
  type PaymentType,
} from "@scalius/core/modules/payments";
import { validateReceiptToken } from "../../utils/order-receipt-token";
import { successEnvelope, errorResponses, serviceUnavailableResponse } from "../../schemas/responses";
import { ok } from "../../utils/api-response";
import { NotFoundError } from "../../utils/api-error";
import { createPaymentSession, isPaymentSessionProcessingResult } from "./payment-session-create";
import { acceptedPaymentSessionProcessing, paymentSessionProcessingResponse } from "./payment-session-response";
import { withPaymentProviderDeadline } from "./payment-provider-deadline";
import {
  claimAndEnqueuePaymentEvent,
  loadCallbackSettings,
  reconcileOrderPayment,
  toGatewayRequest,
} from "./payment-events";

const app = new OpenAPIHono<{ Bindings: Env }>();
const RECEIPT_TOKEN_HEADER = "X-Receipt-Token";
const providerParamSchema = z.object({ provider: z.string().min(1).max(64) });

async function validateReceiptProof(
  c: { env: Env; req: { header: (name: string) => string | undefined } },
  db: Database,
  body: { orderId: string; receiptToken?: string },
): Promise<string> {
  const receiptToken = body.receiptToken ?? (c.req.header(RECEIPT_TOKEN_HEADER)?.trim() || undefined);
  await validateReceiptToken(c.env.CACHE, body.orderId, receiptToken, db);
  if (!receiptToken) throw new Error("Receipt token validation returned without proof.");
  return receiptToken;
}

// ─── POST /{provider}/session ────────────────────────────────────────────────

const sessionSchema = z.object({
  orderId: z.string().min(1),
  receiptToken: z.string().min(1).optional(),
  paymentType: z.enum(["full", "deposit", "balance"]).optional(),
  depositAmount: z.number().positive().optional(),
  replaceExistingAttempt: z.boolean().optional(),
});

const cardSessionSchema = z.object({
  clientSecret: z.string().optional(),
  paymentIntentId: z.string().optional(),
  publishableKey: z.string(),
  amount: z.number(),
  currency: z.string(),
});

const hostedSessionSchema = z.object({
  gatewayUrl: z.string().optional(),
  sessionKey: z.string().optional(),
});

const createSessionRoute = createRoute({
  method: "post",
  path: "/{provider}/session",
  tags: ["Payments"],
  summary: "Create a payment session for an order with the given gateway",
  request: {
    params: providerParamSchema,
    body: { content: { "application/json": { schema: sessionSchema } } },
    headers: z.object({ [RECEIPT_TOKEN_HEADER]: z.string().optional() }),
  },
  responses: {
    200: {
      description: "Card flows return a client secret; hosted flows return the provider redirect URL",
      content: { "application/json": { schema: successEnvelope(z.union([cardSessionSchema, hostedSessionSchema])) } },
    },
    202: paymentSessionProcessingResponse,
    ...errorResponses,
    503: serviceUnavailableResponse,
  },
});

app.openapi(createSessionRoute, async (c) => {
  const db = c.get("db");
  const { provider } = c.req.valid("param");
  const body = c.req.valid("json");
  const receiptToken = await validateReceiptProof(c, db, body);

  const result = await createPaymentSession(c, provider, {
    orderId: body.orderId,
    paymentType: body.paymentType,
    depositAmount: body.depositAmount,
    replaceExistingAttempt: body.replaceExistingAttempt,
    proof: { kind: "receipt", receiptToken },
    returnTarget: { kind: "receipt" },
  });
  if (isPaymentSessionProcessingResult(result)) return acceptedPaymentSessionProcessing(c, result);
  return ok(c, (result.stripe ?? result.hosted)!);
});

// ─── POST /{provider}/reconcile ──────────────────────────────────────────────

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
  path: "/{provider}/reconcile",
  tags: ["Payments"],
  summary: "Verify and reconcile a gateway payment for a private order receipt",
  request: {
    params: providerParamSchema,
    body: { content: { "application/json": { schema: reconcileSchema } } },
    headers: z.object({ [RECEIPT_TOKEN_HEADER]: z.string().optional() }),
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
  const { provider } = c.req.valid("param");
  const body = c.req.valid("json");
  await validateReceiptProof(c, db, body);

  const { data, accepted } = await reconcileOrderPayment({ db, env: c.env, orderId: body.orderId, provider });
  return accepted ? c.json({ success: true as const, data }, 202) : ok(c, data);
});

// ─── Hosted buyer returns ────────────────────────────────────────────────────
// The provider sends the buyer's browser back here (POST, sometimes GET).
// Return fields are context, never payment authority: a success is applied
// only after the gateway verifies it server-to-server.

type ReturnContext = Context<{ Bindings: Env }>;

function normalizePaymentType(value: string | undefined): PaymentType | "" {
  return value === "full" || value === "deposit" || value === "balance" ? value : "";
}

function callbackPaymentType(query: Record<string, string>): PaymentType | "" {
  return normalizePaymentType(query.payment_type ?? query.paymentType);
}

function callbackDepositAmount(query: Record<string, string>): string {
  const value = query.deposit_amount ?? query.depositAmount ?? "";
  const amount = Number(value);
  return value && Number.isFinite(amount) && amount > 0 ? value : "";
}

async function buildReturnRedirectUrl(
  c: ReturnContext,
  provider: string,
  request: GatewayRequest,
  orderId: string,
  result?: HostedPaymentReturnResult,
): Promise<string> {
  const storefront = (c.env?.STOREFRONT_URL || new URL(c.req.url).origin).replace(/\/+$/, "");
  if (orderId) {
    const order = await c.get("db").select({ id: orders.id }).from(orders).where(eq(orders.id, orderId)).get();
    if (!order) return `${storefront}/checkout?error=invalid_order`;
  }
  const { query } = request;
  const returnTo = query.return_to ?? query.returnTo;
  const paymentType = callbackPaymentType(query);

  if (returnTo === "account" && orderId) {
    const url = new URL(`${storefront}/account/orders/${encodeURIComponent(orderId)}`);
    url.searchParams.set("payment", provider);
    if (result) url.searchParams.set("result", result);
    if (paymentType) url.searchParams.set("paymentType", paymentType);
    return url.toString();
  }

  const continuationId = query.continuation_id ?? query.continuationId ?? "";
  if (returnTo === "agent" && /^acn_[A-Za-z0-9_-]{20}$/.test(continuationId)) {
    return new URL(`/checkout/continue/${encodeURIComponent(continuationId)}`, storefront).toString();
  }

  const url = new URL(`${storefront}/order-success`);
  url.searchParams.set("orderId", orderId);
  url.searchParams.set("payment", provider);
  if (result) url.searchParams.set("result", result);
  if (paymentType) url.searchParams.set("paymentType", paymentType);
  const depositAmount = callbackDepositAmount(query);
  if (depositAmount) url.searchParams.set("depositAmount", depositAmount);
  return url.toString();
}

function hostedGateway(c: ReturnContext) {
  const gateway = getPaymentGateway(c.req.param("provider"));
  if (!gateway?.verifyReturn || !gateway.returnCorrelationId) throw new NotFoundError("Payment gateway not found");
  return gateway;
}

async function handleSuccessReturn(c: ReturnContext): Promise<Response> {
  const gateway = hostedGateway(c);
  const request = await toGatewayRequest(c);
  const correlationId = gateway.returnCorrelationId!(request) || request.query.tran_id || "";
  const orderId = request.query.order_id?.trim() || parsePaymentCorrelationId(correlationId).orderId;
  if (request.method === "POST") {
    try {
      const db = c.get("db");
      const loaded = await loadCallbackSettings(gateway, db, c.env);
      if (loaded.status === "ready") {
        const verification = await withPaymentProviderDeadline(
          gateway.label,
          (signal) => gateway.verifyReturn!(loaded.settings, request, signal),
        );
        if (verification.status === "event" && verification.event.kind === "confirmed") {
          await claimAndEnqueuePaymentEvent({
            db,
            queue: c.env.JOBS_QUEUE,
            provider: gateway.id,
            event: verification.event,
            source: "buyer_return",
          });
        }
      }
    } catch (error) {
      console.warn("[payment-return] Buyer-return payment verification did not settle before redirect", {
        provider: gateway.id,
        error: error instanceof Error ? error.message : "verification_failed",
      });
    }
  }
  return c.redirect(await buildReturnRedirectUrl(c, gateway.id, request, orderId));
}

async function handleUnsuccessfulReturn(c: ReturnContext, result: HostedPaymentReturnResult): Promise<Response> {
  const gateway = hostedGateway(c);
  const request = await toGatewayRequest(c);
  // Unsigned returns: only the provider-posted correlation id can select an
  // attempt; query values remain redirect context and must agree with it.
  const correlationId = gateway.returnCorrelationId!(request);
  const parsed = parsePaymentCorrelationId(correlationId);
  const queryOrderId = request.query.order_id?.trim() ?? "";
  const queryPaymentType = callbackPaymentType(request.query);
  const orderId = queryOrderId || (correlationId ? parsed.orderId : "");
  const paymentType = queryPaymentType || parsed.paymentType;
  const contextMatches = Boolean(
    correlationId &&
    orderId &&
    paymentType &&
    (!queryOrderId || !parsed.orderId || queryOrderId === parsed.orderId) &&
    (!queryPaymentType || !parsed.paymentType || queryPaymentType === parsed.paymentType)
  );
  const outcome = contextMatches && paymentType
    ? await reconcileHostedPaymentReturn(c.get("db"), {
        orderId,
        gateway: gateway.id,
        paymentType,
        result,
        providerCorrelationId: correlationId,
      })
    : "ignored";
  return c.redirect(await buildReturnRedirectUrl(c, gateway.id, request, orderId, outcome === "retry_ready" ? result : undefined));
}

app.on(["GET", "POST"], "/:provider/success", handleSuccessReturn);
app.on(["GET", "POST"], "/:provider/fail", (c) => handleUnsuccessfulReturn(c, "failed"));
app.on(["GET", "POST"], "/:provider/cancel", (c) => handleUnsuccessfulReturn(c, "cancelled"));

export const paymentRoutes = app;
