// src/server/routes/payment/sslcommerz-routes.ts
// Hono routes for SSLCommerz payment operations.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import { orders } from "@scalius/database/schema";
import {
  parseSSLCommerzTranId,
  validateSSLCommerzIPN,
} from "@scalius/core/modules/payments/sslcommerz";
import { getSSLCommerzSettings } from "@scalius/core/modules/payments/gateway-settings";
import { validateReceiptToken } from "../../utils/order-receipt-token";
import { successEnvelope, errorResponses, serviceUnavailableResponse } from "../../schemas/responses";
import { ok } from "../../utils/api-response";
import { createSSLCommerzPaymentSession, isPaymentSessionProcessingResult } from "./payment-session-create";
import { acceptedPaymentSessionProcessing, paymentSessionProcessingResponse } from "./payment-session-response";
import { getCredentialEncryptionKey } from "../../utils/encryption-key";
import { withPaymentProviderDeadline } from "./payment-provider-deadline";
import { reconcileValidatedSSLCommerzSuccess } from "../webhooks/sslcommerz";

const app = new OpenAPIHono<{ Bindings: Env }>();
const RECEIPT_TOKEN_HEADER = "X-Receipt-Token";

// ─── POST /session ───────────────────────────────────────────────────────────

const sessionSchema = z.object({
  orderId: z.string().min(1),
  receiptToken: z.string().min(1).optional(),
  paymentType: z.enum(["full", "deposit", "balance"]).optional(),
  depositAmount: z.number().positive().optional(),
  currency: z.string().optional(),
  replaceExistingAttempt: z.boolean().optional(),
});

function getSessionReceiptToken(c: { req: { header: (name: string) => string | undefined } }, body: { receiptToken?: string }): string | undefined {
  const headerToken = c.req.header(RECEIPT_TOKEN_HEADER)?.trim();
  return body.receiptToken ?? (headerToken || undefined);
}

async function validateReceiptProof(
  c: { env: Env; req: { header: (name: string) => string | undefined } },
  db: Database,
  body: { orderId: string; receiptToken?: string },
): Promise<string> {
  const receiptToken = getSessionReceiptToken(c, body);
  await validateReceiptToken(c.env.CACHE, body.orderId, receiptToken, db);
  if (!receiptToken) throw new Error("Receipt token validation returned without proof.");
  return receiptToken;
}

const createSessionRoute = createRoute({
  method: "post",
  path: "/session",
  tags: ["Payments - SSLCommerz"],
  summary: "Create an SSLCommerz payment session",
  request: {
    body: {
      content: {
        "application/json": { schema: sessionSchema }
      }
    },
    headers: z.object({
      [RECEIPT_TOKEN_HEADER]: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "Session created",
      content: {
        "application/json": {
          schema: successEnvelope(z.object({
            gatewayUrl: z.string().optional(),
            sessionKey: z.string().optional(),
          })),
        },
      },
    },
    202: paymentSessionProcessingResponse,
    ...errorResponses,
    503: serviceUnavailableResponse,
  },
});

app.openapi(createSessionRoute, async (c) => {
  const db = c.get("db");
  const body = c.req.valid("json");
  const receiptToken = await validateReceiptProof(c, db, body);

  const result = await createSSLCommerzPaymentSession(c, {
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

  return ok(c, result.hosted);
});

// ─── Redirect handlers ──────────────────────────────────────────────────────
// SSLCommerz POSTs to these callback URLs. Also handle GET for edge cases.
// These are NOT OpenAPI routes — external callbacks, not client-consumed APIs.

async function extractTranId(c: { req: { method: string; parseBody: () => Promise<Record<string, unknown>>; query: (key: string) => string | undefined } }): Promise<string> {
  if (c.req.method === "POST") {
    try {
      const body = await c.req.parseBody();
      return (body as Record<string, string>).tran_id ?? "";
    } catch { /* fall through */ }
  }
  return c.req.query("tran_id") ?? "";
}

async function resolveCallbackOrderId(c: {
  req: {
    method: string;
    parseBody: () => Promise<Record<string, unknown>>;
    query: (key: string) => string | undefined;
  };
}): Promise<string> {
  const queryOrderId = c.req.query("order_id") ?? "";
  if (queryOrderId) return queryOrderId;
  return parseSSLCommerzTranId(await extractTranId(c)).orderId;
}

function getStorefrontUrl(c: { env?: { STOREFRONT_URL?: string }; req: { url: string } }): string {
  const envUrl = c.env?.STOREFRONT_URL;
  if (envUrl) return envUrl.replace(/\/+$/, "");
  return new URL(c.req.url).origin;
}

type SslCallbackContext = {
  req: {
    method: string;
    url: string;
    parseBody: () => Promise<Record<string, unknown>>;
    query: (key: string) => string | undefined;
  };
  env?: { STOREFRONT_URL?: string };
  get: (key: "db") => Pick<Database, "select">;
};

function normalizeCallbackPaymentType(value: string | undefined): "full" | "deposit" | "balance" | "" {
  if (value === "full" || value === "deposit" || value === "balance") return value;
  return "";
}

function getCallbackPaymentType(c: { req: { query: (key: string) => string | undefined } }): "full" | "deposit" | "balance" | "" {
  return normalizeCallbackPaymentType(c.req.query("payment_type") ?? c.req.query("paymentType"));
}

function getCallbackDepositAmount(c: { req: { query: (key: string) => string | undefined } }): string {
  const value = c.req.query("deposit_amount") ?? c.req.query("depositAmount") ?? "";
  if (!value) return "";
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? value : "";
}

function shouldReturnToAccount(c: { req: { query: (key: string) => string | undefined } }): boolean {
  return c.req.query("return_to") === "account" || c.req.query("returnTo") === "account";
}

function getAgentContinuationId(c: { req: { query: (key: string) => string | undefined } }): string | null {
  const returnTo = c.req.query("return_to") ?? c.req.query("returnTo");
  const id = c.req.query("continuation_id") ?? c.req.query("continuationId") ?? "";
  return returnTo === "agent" && /^acn_[A-Za-z0-9_-]{20}$/.test(id) ? id : null;
}

function buildStorefrontAgentContinuationUrl(storefront: string, continuationId: string): string {
  return new URL(`/checkout/continue/${encodeURIComponent(continuationId)}`, storefront).toString();
}

function buildStorefrontOrderSuccessUrl(
  storefront: string,
  params: {
    orderId: string;
    payment: "sslcommerz";
    result?: "failed" | "cancelled";
    paymentType?: "full" | "deposit" | "balance" | "";
    depositAmount?: string;
  },
): string {
  const url = new URL(`${storefront}/order-success`);
  url.searchParams.set("orderId", params.orderId);
  url.searchParams.set("payment", params.payment);
  if (params.result) url.searchParams.set("result", params.result);
  if (params.paymentType) url.searchParams.set("paymentType", params.paymentType);
  if (params.depositAmount) url.searchParams.set("depositAmount", params.depositAmount);
  return url.toString();
}

function buildStorefrontAccountOrderUrl(
  storefront: string,
  params: {
    orderId: string;
    payment: "sslcommerz";
    result?: "failed" | "cancelled";
    paymentType?: "full" | "deposit" | "balance" | "";
  },
): string {
  const url = new URL(`${storefront}/account/orders/${encodeURIComponent(params.orderId)}`);
  url.searchParams.set("payment", params.payment);
  if (params.result) url.searchParams.set("result", params.result);
  if (params.paymentType) url.searchParams.set("paymentType", params.paymentType);
  return url.toString();
}

async function buildSslCallbackRedirectUrl(c: SslCallbackContext, result?: "failed" | "cancelled"): Promise<string> {
  const orderId = await resolveCallbackOrderId(c);
  const storefront = getStorefrontUrl(c);

  if (orderId) {
    const db = c.get("db");
    const order = await db.select({ id: orders.id }).from(orders).where(eq(orders.id, orderId)).get();
    if (!order) return `${storefront}/checkout?error=invalid_order`;
  }

  if (shouldReturnToAccount(c) && orderId) {
    return buildStorefrontAccountOrderUrl(storefront, {
      orderId,
      payment: "sslcommerz",
      result,
      paymentType: getCallbackPaymentType(c),
    });
  }

  const agentContinuationId = getAgentContinuationId(c);
  if (agentContinuationId) {
    return buildStorefrontAgentContinuationUrl(storefront, agentContinuationId);
  }

  return buildStorefrontOrderSuccessUrl(storefront, {
    orderId,
    payment: "sslcommerz",
    result,
    paymentType: getCallbackPaymentType(c),
    depositAmount: getCallbackDepositAmount(c),
  });
}

app.post("/success", async (c) => {
  try {
    const body = await c.req.parseBody().catch((): Record<string, string | File> => ({}));
    const bodyTranId = typeof body.tran_id === "string" ? body.tran_id : "";
    const bodyValId = typeof body.val_id === "string" ? body.val_id : "";
    const tranId = (bodyTranId || c.req.query("tran_id") || "").trim();
    const valId = (bodyValId || c.req.query("val_id") || "").trim();
    const expectedOrderId = c.req.query("order_id")?.trim() || parseSSLCommerzTranId(tranId).orderId;
    const expectedPaymentType = normalizeCallbackPaymentType(
      c.req.query("payment_type") ?? c.req.query("paymentType"),
    ) || null;
    if (tranId && valId && expectedOrderId) {
      const db = c.get("db") as Database;
      const settings = await getSSLCommerzSettings(
        db,
        getCredentialEncryptionKey(c.env as Record<string, unknown>),
      );
      // A gateway may be disabled after the buyer left for the provider. Keep
      // accepting already-authorized historical returns while readable saved
      // credentials remain available, matching the late-IPN policy.
      if (settings?.storeId && settings.storePassword && !settings.credentialErrors?.length) {
        const validation = await withPaymentProviderDeadline(
          "SSLCommerz",
          (signal) => validateSSLCommerzIPN(
            settings.storeId,
            settings.storePassword,
            settings.sandbox,
            valId,
            signal,
          ),
        );
        if (validation && (validation.status === "VALID" || validation.status === "VALIDATED")) {
          await reconcileValidatedSSLCommerzSuccess({
            db,
            queue: c.env.PAYMENT_EVENTS_QUEUE,
            validation,
            requestedValId: valId,
            expectedTranId: tranId,
            expectedOrderId,
            expectedPaymentType,
            source: "buyer_return",
          });
        }
      }
    }
  } catch (error) {
    console.warn("[ssl-return] Buyer-return payment verification did not settle before redirect", {
      error: error instanceof Error ? error.message : "verification_failed",
    });
  }
  return c.redirect(await buildSslCallbackRedirectUrl(c));
});

app.get("/success", async (c) => {
  return c.redirect(await buildSslCallbackRedirectUrl(c));
});

app.post("/fail", async (c) => {
  return c.redirect(await buildSslCallbackRedirectUrl(c, "failed"));
});

app.get("/fail", async (c) => {
  return c.redirect(await buildSslCallbackRedirectUrl(c, "failed"));
});

app.post("/cancel", async (c) => {
  return c.redirect(await buildSslCallbackRedirectUrl(c, "cancelled"));
});

app.get("/cancel", async (c) => {
  return c.redirect(await buildSslCallbackRedirectUrl(c, "cancelled"));
});

export const sslcommerzPaymentRoutes = app;
