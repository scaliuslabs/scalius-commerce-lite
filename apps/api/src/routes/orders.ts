import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Database } from "@scalius/database/client";

import {
  orders,
  checkoutAttempts,
  orderItems,
  media,
  PaymentMethod,
  InventoryPool
} from "@scalius/database/schema";
import { quoteStorefrontDiscount } from "@scalius/core/modules/promotions";
import {
  getCheckoutGatewayPrecommitIssue,
  getPaymentMethodCurrencyIssue,
  isOnlinePaymentMethod,
  listPaymentMethodIds,
} from "@scalius/core/modules/payments/gateways/registry";
import { and, eq, isNull, sql } from "drizzle-orm";
import { phoneNumberSchema } from "@scalius/shared/customer-utils";
import { getDecimalPlaces } from "@scalius/shared/currency";
import { getCustomerBySession, getSessionCookie } from "@scalius/core/modules/customers/customer-auth.service";
import { getCustomerVisibleBalanceDueMinor } from "@scalius/core/modules/customers/customers.service";
import { sendOrderLookupOtp, verifyOrderLookupOtp } from "@scalius/core/modules/orders/order-lookup";
import { orderMoneyAmounts, orderMoneySelection } from "@scalius/core/modules/orders/order-money";
import { fromMinor, toMinor } from "@scalius/shared/money";
import { getCurrentPublicMediaUrl } from "@scalius/core/integrations/storage";
import { publishedMediaObjectKey } from "@scalius/core/modules/media/media.presentation";
import type { CheckoutPaymentMethodId } from "@scalius/core/modules/settings/checkout-flow";
import { getCurrencySettings } from "@scalius/core/modules/settings/site-settings.service";
import {
  deleteOrderPaymentRecoveryChallenge,
  createReceiptOrderSupportRequest,
  assertStorefrontCheckoutQuoteFingerprint,
  buildStorefrontCheckoutQuoteFingerprint,
  CUSTOMER_ORDER_SUPPORT_REQUEST_TYPES,
  getOrderSupportRequestStatusLabel,
  getReceiptOrderSupportRequestStateForOrder,
  buildCheckoutAttemptIdentity,
  commitStorefrontOrderPayload,
  createAtomicCheckoutAttempt,
  createStorefrontOrder,
  createTrustedStorefrontCheckoutPolicySnapshot,
  getCheckoutAttemptRequestKeyFromStatusToken,
  resolveExistingCheckoutAttempt,
  runStorefrontOrderPostCommitSideEffects,
  sendOrderPaymentRecoveryOtp,
  assertStorefrontCheckoutPolicy,
  loadStorefrontCheckoutReads,
  presentStorefrontCartValidation,
  presentStorefrontDeliveryPreflight,
  validateStorefrontDeliveryPreflight,
  validateStorefrontCartItems,
  verifyOrderPaymentRecoveryOtp,
  type StorefrontCheckoutAuthoritySnapshot,
  type StorefrontCheckoutSettingsSnapshot,
} from "@scalius/core/modules/orders";
import {
  buildStorefrontTaxAllocationLineId,
  calculateStorefrontTaxQuote,
  type TaxQuote,
} from "@scalius/core/modules/tax";
import { CUSTOMER_AUTH_OTP_CHANNELS } from "@scalius/shared/customer-auth-policy";
import {
  bumpCacheGeneration,
  getOptionalExecutionContext,
  type WaitUntilExecutionContext,
} from "../utils/cache-generation";
import { AppError, NotFoundError, ValidationError, RateLimitError, UnauthorizedError, ServiceUnavailableError } from "../utils/api-error";
import { getCredentialEncryptionKey, getCustomerSessionHashKey } from "../utils/encryption-key";
import { getClientIp } from "@scalius/shared/rate-limit";
import { isWithinRateLimit } from "../utils/rate-limit";
import {
  RECEIPT_TOKEN_TTL_SECONDS,
  getCheckoutStatusKvKey,
  getReceiptTokenKvKey,
  validateReceiptToken,
} from "../utils/order-receipt-token";

import { created, ok } from "../utils/api-response";
import { successEnvelope, errorResponses, serviceUnavailableResponse, conflictResponse } from "../schemas/responses";
import { enqueueOrderSupportRequestNotificationForOrder } from "../utils/order-notification-queue";
import { authMiddleware } from "../middleware/auth";
import { getTrustedClientIp } from "../utils/client-ip";
const app = new OpenAPIHono<{ Bindings: Env }>();
const CUSTOMER_SESSION_HEADER = "X-Customer-Session";
const RECEIPT_TOKEN_HEADER = "X-Receipt-Token";
const CHECKOUT_STATUS_TTL_SECONDS = 86400;
type CheckoutCustomerIdentity = {
  customerId: string;
  source: "authenticated";
} | null;
type CheckoutSettingsSnapshot = StorefrontCheckoutSettingsSnapshot;
type CheckoutOrderPolicyResult = {
  customerIdentity: CheckoutCustomerIdentity;
  checkoutSettings: CheckoutSettingsSnapshot;
};

type CheckoutDiagnosticPhase =
  | "attempt"
  | "authority"
  | "policy"
  | "prepare"
  | "rate_limit"
  | "commit"
  | "post_commit";

function createCheckoutDiagnostics(env: Env): {
  mark: (phase: CheckoutDiagnosticPhase) => void;
  apply: (context: { header: (name: string, value: string) => void }) => void;
} | null {
  if (
    (env as unknown as Record<string, unknown>).CHECKOUT_LOADTEST_DIAGNOSTICS
      !== "1"
  ) {
    return null;
  }
  let last = performance.now();
  const durations: Array<{ phase: CheckoutDiagnosticPhase; durationMs: number }> = [];
  return {
    mark(phase) {
      const now = performance.now();
      durations.push({ phase, durationMs: Math.max(0, now - last) });
      last = now;
    },
    apply(context) {
      context.header(
        "Server-Timing",
        durations.map(({ phase, durationMs }) =>
          `${phase};dur=${durationMs.toFixed(1)}`
        ).join(", "),
      );
    },
  };
}

async function enforceCheckoutRateLimits(
  env: Env,
  request: Request,
  customerPhone: string,
): Promise<void> {
  const [ipAllowed, phoneAllowed] = await Promise.all([
    isWithinRateLimit(env, "RL_STANDARD", "checkout-ip", getClientIp(request)),
    isWithinRateLimit(env, "RL_STRICT", "checkout-phone", customerPhone),
  ]);
  if (!ipAllowed || !phoneAllowed) {
    throw new RateLimitError("Too many order requests. Please try again later.");
  }
}

function scheduleCheckoutRecoveryHint(
  task: Promise<unknown>,
  executionCtx: WaitUntilExecutionContext | undefined,
): void {
  const guardedTask = task.catch((error: unknown) => {
    console.error("[Orders] Failed to write checkout recovery hint:", error);
  });

  if (executionCtx && typeof executionCtx.waitUntil === "function") {
    executionCtx.waitUntil(guardedTask);
    return;
  }

  void guardedTask;
}

function scheduleCheckoutSuccessRecoveryHints(
  env: Env,
  statusToken: string,
  receiptToken: string,
  orderId: string,
  executionCtx: WaitUntilExecutionContext | undefined,
): void {
  if (!env.CACHE) return;

  try {
    scheduleCheckoutRecoveryHint(
      Promise.all([
        getCheckoutStatusKvKey(statusToken).then((statusKey) =>
          env.CACHE.put(
            statusKey,
            JSON.stringify({
              status: "completed",
              orderId,
              updatedAt: Date.now(),
            }),
            { expirationTtl: CHECKOUT_STATUS_TTL_SECONDS },
          ),
        ),
        getReceiptTokenKvKey(receiptToken).then((receiptKey) => env.CACHE.put(
          receiptKey,
          JSON.stringify({ orderId }),
          { expirationTtl: RECEIPT_TOKEN_TTL_SECONDS },
        )),
      ]),
      executionCtx,
    );
  } catch (error) {
    console.error("[Orders] Failed to schedule checkout success recovery hint:", error);
  }
}

function scheduleCheckoutFailureStatusHint(
  env: Env,
  statusToken: string,
  orderId: string,
  errorMessage: string,
  executionCtx: WaitUntilExecutionContext | undefined,
): void {
  if (!env.CACHE) return;

  try {
    scheduleCheckoutRecoveryHint(
      getCheckoutStatusKvKey(statusToken).then((statusKey) =>
        env.CACHE.put(
          statusKey,
          JSON.stringify({
            status: "failed",
            orderId,
            error: errorMessage,
            updatedAt: Date.now(),
          }),
          { expirationTtl: CHECKOUT_STATUS_TTL_SECONDS },
        ),
      ),
      executionCtx,
    );
  } catch (error) {
    console.error("[Orders] Failed to schedule checkout failure recovery hint:", error);
  }
}

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

function getCustomerSessionTokenFromRequest(c: { req: { header: (name: string) => string | undefined } }): string | null {
  const explicitSessionToken = c.req.header(CUSTOMER_SESSION_HEADER)?.trim();
  if (explicitSessionToken) return explicitSessionToken;

  return getSessionCookie(c.req.header("Cookie") ?? null);
}

function getReceiptTokenFromHeader(c: { req: { header: (name: string) => string | undefined } }): string | undefined {
  const token = c.req.header(RECEIPT_TOKEN_HEADER)?.trim();
  return token || undefined;
}

async function assertCheckoutOrderPolicy(
  c: {
    env: Env;
    get: (key: "db") => Database;
    req: { header: (name: string) => string | undefined };
  },
  customerPhone: string,
  paymentMethod: CheckoutPaymentMethodId,
  authority: Pick<
    StorefrontCheckoutAuthoritySnapshot,
    "checkoutSettings" | "allowedCountries" | "activePaymentMethods"
  >,
): Promise<CheckoutOrderPolicyResult> {
  const db = c.get("db");
  const checkoutSettings = authority.checkoutSettings;
  const checkoutSettingsSnapshot = assertStorefrontCheckoutPolicy(
    customerPhone,
    paymentMethod,
    authority,
  );

  const sessionToken = getCustomerSessionTokenFromRequest(c);
  if (!sessionToken) {
    if (checkoutSettings?.guestCheckoutEnabled ?? true) {
      return { customerIdentity: null, checkoutSettings: checkoutSettingsSnapshot };
    }

    throw new UnauthorizedError("Please sign in before checkout.");
  }

  const session = await getCustomerBySession(
    db,
    sessionToken,
    getCustomerSessionHashKey(c.env as unknown as Record<string, unknown>),
  );
  if (!session?.customerId) {
    if (checkoutSettings?.guestCheckoutEnabled ?? true) {
      throw new AppError(401, "CUSTOMER_SESSION_STALE", "Your session expired. Please sign in again or continue as a guest.");
    }

    throw new UnauthorizedError("Please sign in before checkout.");
  }

  if (!session.phone) {
    throw new ValidationError(
      "Your signed-in account is missing its required phone number. Update your profile and try again.",
    );
  }

  return {
    customerIdentity: {
      customerId: session.customerId,
      source: "authenticated",
    },
    checkoutSettings: checkoutSettingsSnapshot,
  };
}

const unixToDate = (timestamp: number | null): Date | null => {
  if (!timestamp) return null;
  return new Date(timestamp * 1000);
};

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

// ─── GET /receipt/:id ───────────────────────────────────────────────────────

const receiptSupportRequestSchema = z.object({
  id: z.string(),
  orderId: z.string(),
  customerId: z.string().nullable(),
  type: z.enum(CUSTOMER_ORDER_SUPPORT_REQUEST_TYPES),
  status: z.string(),
  active: z.boolean(),
  severity: z.enum(["info", "success", "warning", "danger"]),
  label: z.string(),
  actionLabel: z.string(),
  reason: z.string(),
  message: z.string().nullable(),
  submittedAt: z.string().nullable(),
  resolvedAt: z.string().nullable(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
});

const receiptSupportRequestActionSchema = z.object({
  type: z.enum(CUSTOMER_ORDER_SUPPORT_REQUEST_TYPES),
  label: z.string(),
  description: z.string(),
  eligible: z.boolean(),
  disabledReason: z.string().nullable(),
});

const orderReceiptSchema = z.object({
  id: z.string(),
  customerName: z.string(),
  /** The phone the courier calls. The receipt is proof-gated, so the buyer sees their own contact. */
  customerPhone: z.string(),
  customerEmail: z.string().nullable(),
  /** True when the order is saved to a customer account. */
  accountLinked: z.boolean(),
  shippingAddress: z.string(),
  totalAmount: z.number(),
  shippingCharge: z.number(),
  discountAmount: z.number().nullable(),
  currencyCode: z.string().nullable(),
  currencyDecimalPlaces: z.number().int().nullable(),
  subtotalAmountMinor: z.number().int().nullable(),
  shippingAmountMinor: z.number().int().nullable(),
  shippingMethodId: z.string().nullable(),
  shippingMethodName: z.string().nullable(),
  shippingMethodDescription: z.string().nullable(),
  shippingMethodBaseAmountMinor: z.number().int().nullable(),
  shippingFeeWaived: z.boolean().nullable(),
  discountAmountMinor: z.number().int().nullable(),
  taxAmountMinor: z.number().int(),
  totalAmountMinor: z.number().int().nullable(),
  taxLabel: z.string().nullable(),
  pricesIncludeTax: z.boolean(),
  city: z.string(),
  zone: z.string(),
  area: z.string().nullable(),
  cityName: z.string().nullable(),
  zoneName: z.string().nullable(),
  areaName: z.string().nullable(),
  status: z.string(),
  paymentMethod: z.string().nullable(),
  paymentStatus: z.string(),
  paidAmount: z.number(),
  balanceDue: z.number(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  items: z.array(z.object({
    id: z.string(),
    productId: z.string(),
    variantId: z.string().nullable(),
    quantity: z.number(),
    price: z.number(),
    productName: z.string().nullable(),
    productImage: z.string().nullable(),
    variantLabel: z.string().nullable(),
    unitPriceMinor: z.number().int().nullable(),
    lineSubtotalMinor: z.number().int().nullable(),
    discountAmountMinor: z.number().int().nullable(),
    taxableAmountMinor: z.number().int().nullable(),
    taxAmountMinor: z.number().int(),
  })),
  supportRequests: z.array(receiptSupportRequestSchema),
  supportRequestActions: z.array(receiptSupportRequestActionSchema),
  supportRequestIntro: z.string(),
});

const receiptSupportRequestResponseSchema = z.object({
  request: receiptSupportRequestSchema,
  supportRequests: z.array(receiptSupportRequestSchema),
  supportRequestActions: z.array(receiptSupportRequestActionSchema),
  supportRequestIntro: z.string(),
});

const orderPaymentRecoveryChannelSchema = z.enum(CUSTOMER_AUTH_OTP_CHANNELS);
const ORDER_PAYMENT_RECOVERY_GENERIC_MESSAGE =
  "If this order is eligible for payment recovery, a verification code will be sent to the buyer contact.";

const sendOrderPaymentRecoveryOtpRoute = createRoute({
  method: "post",
  path: "/payment-recovery/send-otp",
  tags: ["Orders"],
  summary: "Request a buyer verification code for hosted payment recovery",
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({
            orderId: z.string().trim().min(1).max(128),
            channel: orderPaymentRecoveryChannelSchema.optional(),
          }).strict(),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Payment recovery code request accepted",
      content: {
        "application/json": {
          schema: successEnvelope(z.object({ message: z.string() })),
        },
      },
    },
    503: serviceUnavailableResponse,
    ...errorResponses,
  },
});

app.openapi(sendOrderPaymentRecoveryOtpRoute, async (c) => {
  const db = c.get("db");
  const body = c.req.valid("json");
  c.header("Cache-Control", "private, no-cache, no-store, must-revalidate");
  c.header("Pragma", "no-cache");
  c.header("Expires", "0");

  let result: Awaited<ReturnType<typeof sendOrderPaymentRecoveryOtp>>;
  try {
    result = await sendOrderPaymentRecoveryOtp(db, {
      orderId: body.orderId,
      channel: body.channel,
      ip: getTrustedClientIp(c),
      emailEnv: c.env as unknown as Record<string, unknown>,
      encryptionKey: getCredentialEncryptionKey(c.env as unknown as Record<string, unknown>),
      credentialEncryptionKey: getCredentialEncryptionKey(c.env as unknown as Record<string, unknown>),
    });
  } catch (error) {
    if (error instanceof ValidationError || error instanceof NotFoundError) {
      return ok(c, { message: ORDER_PAYMENT_RECOVERY_GENERIC_MESSAGE });
    }
    throw error;
  }

  if (result.queuePayload) {
    try {
      await c.env.JOBS_QUEUE.send(result.queuePayload);
    } catch (error) {
      if (result.challengeKey && result.deliveryKey) {
        await deleteOrderPaymentRecoveryChallenge(db, {
          challengeKey: result.challengeKey,
          deliveryKey: result.deliveryKey,
        }).catch((deleteError: unknown) => {
          console.error("[Orders] Failed to clear payment recovery challenge after queue handoff failure:", deleteError);
        });
      }
      console.error("[Orders] Failed to enqueue payment recovery OTP:", error);
      throw new ServiceUnavailableError("Could not queue verification code delivery. Please try again.");
    }
  }

  return ok(c, { message: ORDER_PAYMENT_RECOVERY_GENERIC_MESSAGE });
});

const verifyOrderPaymentRecoveryOtpRoute = createRoute({
  method: "post",
  path: "/payment-recovery/verify-otp",
  tags: ["Orders"],
  summary: "Verify payment recovery code and issue a private receipt proof",
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({
            orderId: z.string().trim().min(1).max(128),
            channel: orderPaymentRecoveryChannelSchema,
            code: z.string().trim().min(4).max(12),
          }).strict(),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Payment recovery verified",
      content: {
        "application/json": {
          schema: successEnvelope(z.object({
            orderId: z.string(),
            receiptToken: z.string(),
            expiresAt: z.number(),
            gateway: z.string(),
            paymentType: z.enum(["full", "deposit", "balance"]).nullable(),
            depositAmount: z.number().nullable(),
            redirectParams: z.object({
              payment: z.string(),
              result: z.literal("failed"),
              paymentType: z.string().optional(),
              depositAmount: z.number().optional(),
            }),
          })),
        },
      },
    },
    503: serviceUnavailableResponse,
    ...errorResponses,
  },
});

app.use("/payment-recovery/verify-otp", authMiddleware);
app.openapi(verifyOrderPaymentRecoveryOtpRoute, async (c) => {
  const db = c.get("db");
  const body = c.req.valid("json");
  c.header("Cache-Control", "private, no-cache, no-store, must-revalidate");
  c.header("Pragma", "no-cache");
  c.header("Expires", "0");

  const result = await verifyOrderPaymentRecoveryOtp(db, {
    orderId: body.orderId,
    channel: body.channel,
    code: body.code,
    encryptionKey: getCredentialEncryptionKey(c.env as unknown as Record<string, unknown>),
  });

  return ok(c, result);
});

// ─── Track your order (public lookup) ──────────────────────────────────────

const orderLookupBodySchema = z.object({
  reference: z.string().trim().min(1).max(64).openapi({ description: 'Order number ("#1001") or order id' }),
  phone: z.string().trim().min(1).max(32).openapi({ description: "Phone number used for the order" }),
}).strict();

const sendOrderLookupOtpRoute = createRoute({
  method: "post",
  path: "/lookup/send-otp",
  tags: ["Orders"],
  summary: "Send a code to the contact saved on an order (never reveals whether it matched)",
  request: {
    body: { required: true, content: { "application/json": { schema: orderLookupBodySchema } } },
  },
  responses: {
    200: {
      description: "Request accepted",
      content: {
        "application/json": {
          schema: successEnvelope(z.object({ message: z.string(), resendAfterSeconds: z.number().int() })),
        },
      },
    },
    503: serviceUnavailableResponse,
    ...errorResponses,
  },
});

app.openapi(sendOrderLookupOtpRoute, async (c) => {
  const db = c.get("db");
  const body = c.req.valid("json");
  const env = c.env as unknown as Record<string, unknown>;
  c.header("Cache-Control", "private, no-cache, no-store, must-revalidate");

  const result = await sendOrderLookupOtp(db, {
    reference: body.reference,
    phone: body.phone,
    ip: getTrustedClientIp(c),
    emailEnv: env,
    encryptionKey: getCredentialEncryptionKey(env),
    credentialEncryptionKey: getCredentialEncryptionKey(env),
  });
  if (result.queuePayload) {
    try {
      await c.env.JOBS_QUEUE.send(result.queuePayload);
    } catch (error) {
      if (result.challengeKey && result.deliveryKey) {
        await deleteOrderPaymentRecoveryChallenge(db, {
          challengeKey: result.challengeKey,
          deliveryKey: result.deliveryKey,
        }).catch(() => undefined);
      }
      console.error("[Orders] Failed to enqueue order lookup code:", error instanceof Error ? error.name : typeof error);
      throw new ServiceUnavailableError("We couldn't send the code. Please try again.");
    }
  }
  return ok(c, { message: result.message, resendAfterSeconds: result.resendAfterSeconds });
});

const verifyOrderLookupOtpRoute = createRoute({
  method: "post",
  path: "/lookup/verify-otp",
  tags: ["Orders"],
  summary: "Verify an order lookup code and issue a private receipt proof",
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: orderLookupBodySchema.extend({ code: z.string().trim().min(4).max(12) }).strict(),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Verified",
      content: {
        "application/json": {
          schema: successEnvelope(z.object({
            orderId: z.string(),
            receiptToken: z.string(),
            expiresAt: z.number(),
          })),
        },
      },
    },
    ...errorResponses,
  },
});

app.use("/lookup/verify-otp", authMiddleware);
app.openapi(verifyOrderLookupOtpRoute, async (c) => {
  const body = c.req.valid("json");
  c.header("Cache-Control", "private, no-cache, no-store, must-revalidate");
  const result = await verifyOrderLookupOtp(c.get("db"), {
    reference: body.reference,
    phone: body.phone,
    code: body.code,
    encryptionKey: getCredentialEncryptionKey(c.env as unknown as Record<string, unknown>),
  });
  return ok(c, result);
});

const getOrderReceiptRoute = createRoute({
  method: "get",
  path: "/receipt/{id}",
  tags: ["Orders"],
  summary: "Get minimal order receipt by ID and receipt token",
  request: {
    params: z.object({
      id: z.string(),
    }),
    headers: z.object({
      [RECEIPT_TOKEN_HEADER]: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "Minimal order receipt",
      content: {
        "application/json": {
          schema: successEnvelope(z.object({ order: orderReceiptSchema })),
        },
      },
    },
    404: errorResponses[404],
  },
});

app.openapi(getOrderReceiptRoute, async (c) => {
  const db = c.get("db");
  const id = c.req.valid("param").id;
  const token = getReceiptTokenFromHeader(c);

  c.header("Cache-Control", "no-cache, no-store, must-revalidate");
  c.header("Pragma", "no-cache");
  c.header("Expires", "0");

  await validateReceiptToken(c.env.CACHE, id, token, db);

  const order = await db
    .select({
      id: orders.id,
      customerId: orders.customerId,
      customerName: orders.customerName,
      customerPhone: orders.customerPhone,
      customerEmail: orders.customerEmail,
      accountOwnerCustomerId: orders.accountOwnerCustomerId,
      shippingAddress: orders.shippingAddress,
      ...orderMoneySelection(orders),
      currencyCode: orders.currencyCode,
      subtotalAmountMinor: orders.subtotalAmountMinor,
      shippingMethodId: orders.shippingMethodId,
      shippingMethodName: orders.shippingMethodName,
      shippingMethodDescription: orders.shippingMethodDescription,
      shippingMethodBaseAmountMinor: orders.shippingMethodBaseAmountMinor,
      shippingFeeWaived: orders.shippingFeeWaived,
      taxAmountMinor: orders.taxAmountMinor,
      taxLabel: orders.taxLabel,
      pricesIncludeTax: orders.pricesIncludeTax,
      city: orders.city,
      zone: orders.zone,
      area: orders.area,
      cityName: orders.cityName,
      zoneName: orders.zoneName,
      areaName: orders.areaName,
      status: orders.status,
      paymentMethod: orders.paymentMethod,
      paymentStatus: orders.paymentStatus,
      fulfillmentStatus: orders.fulfillmentStatus,
      createdAt: sql<number>`CAST(${orders.createdAt} AS INTEGER)`,
      updatedAt: sql<number>`CAST(${orders.updatedAt} AS INTEGER)`
    })
    .from(orders)
    .where(and(eq(orders.id, id), isNull(orders.deletedAt)))
    .get();

  if (!order) {
    throw new NotFoundError("Order receipt not found");
  }

  const [items, supportState] = await Promise.all([
    db
      .select({
        id: orderItems.id,
        productId: orderItems.productId,
        variantId: orderItems.variantId,
        quantity: orderItems.quantity,
        productName: orderItems.productName,
        productImageObjectKey: publishedMediaObjectKey(),
        productImageStatus: media.status,
        variantLabel: orderItems.variantLabel,
        unitPriceMinor: orderItems.unitPriceMinor,
        lineSubtotalMinor: orderItems.lineSubtotalMinor,
        discountAmountMinor: orderItems.discountAmountMinor,
        taxableAmountMinor: orderItems.taxableAmountMinor,
        taxAmountMinor: orderItems.taxAmountMinor,
      })
      .from(orderItems)
      .leftJoin(media, eq(media.id, orderItems.productImageMediaId))
      .where(eq(orderItems.orderId, id)),
    getReceiptOrderSupportRequestStateForOrder(db, order),
  ]);

  const money = orderMoneyAmounts(order);
  return ok(c, {
    order: {
      id: order.id,
      customerName: order.customerName,
      customerPhone: order.customerPhone,
      customerEmail: order.customerEmail,
      accountLinked: order.accountOwnerCustomerId !== null,
      shippingAddress: order.shippingAddress,
      totalAmount: money.totalAmount,
      shippingCharge: money.shippingCharge,
      discountAmount: money.discountAmount,
      currencyCode: order.currencyCode,
      currencyDecimalPlaces: order.currencyDecimalPlaces,
      subtotalAmountMinor: order.subtotalAmountMinor,
      shippingAmountMinor: order.shippingAmountMinor,
      shippingMethodId: order.shippingMethodId,
      shippingMethodName: order.shippingMethodName,
      shippingMethodDescription: order.shippingMethodDescription,
      shippingMethodBaseAmountMinor: order.shippingMethodBaseAmountMinor,
      shippingFeeWaived: order.shippingFeeWaived,
      discountAmountMinor: order.discountAmountMinor,
      taxAmountMinor: order.taxAmountMinor,
      totalAmountMinor: order.totalAmountMinor,
      taxLabel: order.taxLabel,
      pricesIncludeTax: order.pricesIncludeTax,
      city: order.city,
      zone: order.zone,
      area: order.area,
      cityName: order.cityName,
      zoneName: order.zoneName,
      areaName: order.areaName,
      status: order.status,
      paymentMethod: order.paymentMethod,
      paymentStatus: order.paymentStatus,
      paidAmount: money.paidAmount,
      balanceDue: fromMinor(getCustomerVisibleBalanceDueMinor(order), order.currencyDecimalPlaces),
      createdAt: unixToDate(order.createdAt)?.toISOString() || null,
      updatedAt: unixToDate(order.updatedAt)?.toISOString() || null,
      items: items.map(({ productImageObjectKey, productImageStatus, ...item }) => ({
        ...item,
        price: fromMinor(item.unitPriceMinor, order.currencyDecimalPlaces),
        productImage:
          productImageObjectKey &&
          (productImageStatus === "ready" || productImageStatus === "trashed")
            ? getCurrentPublicMediaUrl(productImageObjectKey)
            : null,
      })),
      supportRequests: supportState.supportRequests,
      supportRequestActions: supportState.supportRequestActions,
      supportRequestIntro: supportState.supportRequestIntro,
    },
  });
});

const createReceiptSupportRequestRoute = createRoute({
  method: "post",
  path: "/receipt/{id}/support-requests",
  tags: ["Orders"],
  summary: "Create a receipt-token support request for an order",
  request: {
    params: z.object({
      id: z.string(),
    }),
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({
            token: z.string(),
            type: z.enum(CUSTOMER_ORDER_SUPPORT_REQUEST_TYPES),
            reason: z.string().trim().min(3).max(500),
            message: z.string().trim().max(1000).nullable().optional(),
          }).strict(),
        },
      },
    },
  },
  responses: {
    201: {
      description: "Receipt support request created",
      content: {
        "application/json": {
          schema: successEnvelope(receiptSupportRequestResponseSchema),
        },
      },
    },
    409: conflictResponse,
    ...errorResponses,
  },
});

app.openapi(createReceiptSupportRequestRoute, async (c) => {
  const db = c.get("db");
  const id = c.req.valid("param").id;
  const body = c.req.valid("json");

  c.header("Cache-Control", "no-cache, no-store, must-revalidate");
  c.header("Pragma", "no-cache");
  c.header("Expires", "0");

  await validateReceiptToken(c.env.CACHE, id, body.token, db);
  const result = await createReceiptOrderSupportRequest(db, id, {
    type: body.type,
    reason: body.reason,
    message: body.message,
  });
  await enqueueOrderSupportRequestNotificationForOrder({
    db,
    queue: c.env.JOBS_QUEUE,
    orderId: id,
    requestId: result.request.id,
    notificationType: "support_request_submitted",
    source: "receipt-support-request",
    status: result.request.status,
    data: {
      supportRequestType: result.request.type,
      supportRequestTypeLabel: result.request.label,
      supportRequestStatus: result.request.status,
      supportRequestStatusLabel: getOrderSupportRequestStatusLabel(result.request.status),
    },
  });

  return created(c, result);
});

// ─── POST / ──────────────────────────────────────────────────────────────────

const cartIssueSchema = z.object({
  index: z.number(),
  cartKey: z.string().nullable().optional(),
  productId: z.string(),
  variantId: z.string().nullable(),
  code: z.enum([
    "PRODUCT_UNAVAILABLE",
    "VARIANT_REQUIRED",
    "VARIANT_UNAVAILABLE",
    "VARIANT_MISMATCH",
    "QUANTITY_UNAVAILABLE",
    "PRICE_CHANGED",
  ]),
  action: z.enum(["remove", "select_variant", "reduce_quantity", "refresh_item"]),
  message: z.string(),
  productName: z.string().nullable(),
  variantLabel: z.string().nullable(),
  requestedQuantity: z.number(),
  availableQuantity: z.number().optional(),
  submittedPrice: z.number().optional(),
  currentPrice: z.number().optional(),
});

const persistedStorefrontVariantIdSchema = z
  .string()
  .trim()
  .min(1, "A saved product variant is required")
  .max(180, "Product variant id is too long")
  .regex(/^(?!default$).+$/, "A saved product variant is required");

const cartValidationItemSchema = z.object({
  cartKey: z.string().min(1).max(256).optional().nullable(),
  productId: z.string().min(1, "Product is required"),
  variantId: persistedStorefrontVariantIdSchema,
  quantity: z.number().int("Quantity must be a whole number").min(1, "Quantity must be at least 1").max(99, "Quantity must be at most 99"),
  price: z.number().min(0, "Price must be greater than or equal to 0"),
  productName: z.string().optional().nullable(),
  variantLabel: z.string().optional().nullable(),
});

const taxQuoteItemSchema = z.object({
  cartKey: z.string().min(1).max(256).optional().nullable(),
  productId: z.string().min(1, "Product is required").max(180),
  variantId: persistedStorefrontVariantIdSchema,
  quantity: z.number().int().min(1).max(99),
  productName: z.string().max(200).optional().nullable(),
  variantLabel: z.string().max(200).optional().nullable(),
});

const storefrontShippingMethodSnapshotSchema = z.object({
  id: z.string().min(1).max(180),
  name: z.string().min(1).max(100),
  description: z.string().max(255).nullable(),
  baseAmountMinor: z.number().int().nonnegative(),
  feeWaived: z.boolean(),
});

const taxQuoteResponseSchema = z.object({
  valid: z.literal(true),
  quoteFingerprint: z.string(),
  displayLabel: z.string(),
  pricesIncludeTax: z.boolean(),
  shippingTaxed: z.boolean(),
  currencyCode: z.string(),
  decimalPlaces: z.number().int(),
  settingsVersion: z.number().int(),
  subtotalMinor: z.number().int(),
  subtotalAmount: z.number(),
  shippingMinor: z.number().int(),
  shippingAmount: z.number(),
  discountMinor: z.number().int(),
  discountAmount: z.number(),
  taxMinor: z.number().int(),
  taxAmount: z.number(),
  totalMinor: z.number().int(),
  totalAmount: z.number(),
  shippingMethod: storefrontShippingMethodSnapshotSchema,
  discountOffers: z.array(z.string().max(160)).max(3).openapi({
    description: "Automatic Buy X get Y discounts the buyer has earned but not claimed: the free item is not in the cart yet.",
  }),
  items: z.array(z.object({
    cartKey: z.string().nullable().optional(),
    productId: z.string(),
    variantId: z.string(),
    quantity: z.number().int(),
    unitPrice: z.number(),
    productName: z.string(),
    variantLabel: z.string().nullable(),
  })),
});

const taxQuoteRoute = createRoute({
  method: "post",
  path: "/tax-quote",
  tags: ["Orders"],
  summary: "Calculate an authoritative storefront tax quote",
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({
            items: z.array(taxQuoteItemSchema).min(1).max(99),
            inventoryPool: z.enum([
              InventoryPool.REGULAR,
              InventoryPool.PREORDER,
              InventoryPool.BACKORDER,
            ]).default(InventoryPool.REGULAR),
            city: z.string().min(1).max(180),
            zone: z.string().min(1).max(180),
            area: z.string().max(180).optional().nullable(),
            shippingMethodId: z.string().min(1).max(180),
            discountCode: z.string().trim().max(100).optional().nullable(),
            customerPhone: phoneNumberSchema.optional().nullable(),
          }).strict(),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Authoritative tax quote",
      content: { "application/json": { schema: successEnvelope(taxQuoteResponseSchema) } },
    },
    400: errorResponses[400],
    500: errorResponses[500],
  },
});

const cartValidationRoute = createRoute({
  method: "post",
  path: "/cart-validation",
  tags: ["Orders"],
  summary: "Validate a storefront cart before checkout",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            items: z.array(cartValidationItemSchema).min(1).max(99),
            inventoryPool: z
              .enum([InventoryPool.REGULAR, InventoryPool.PREORDER, InventoryPool.BACKORDER])
              .default(InventoryPool.REGULAR),
            city: z.string().min(1).optional().nullable(),
            zone: z.string().min(1).optional().nullable(),
            area: z.string().optional().nullable(),
            shippingMethodId: z.string().optional().nullable(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Cart validation result",
      content: {
        "application/json": {
          schema: successEnvelope(z.object({
            valid: z.boolean(),
            issues: z.array(cartIssueSchema),
            items: z.array(z.object({
              index: z.number(),
              cartKey: z.string().nullable().optional(),
              productId: z.string(),
              variantId: persistedStorefrontVariantIdSchema,
              quantity: z.number(),
              unitPrice: z.number(),
              productName: z.string(),
              variantLabel: z.string().nullable(),
              freeDelivery: z.boolean(),
              availableQuantity: z.number().nullable(),
              productImageMediaId: z.string().nullable(),
              productImage: z.string().url().nullable(),
            })),
            subtotal: z.number(),
            hasFreeDeliveryProduct: z.boolean(),
            delivery: z.object({
              shippingCharge: z.number(),
              shippingMethod: storefrontShippingMethodSnapshotSchema,
              cityName: z.string(),
              zoneName: z.string(),
              areaName: z.string().nullable(),
            }).optional(),
          })),
        },
      },
    },
    400: errorResponses[400],
    500: errorResponses[500],
  },
});

app.openapi(cartValidationRoute, async (c) => {
  const db = c.get("db");
  const data = c.req.valid("json");
  const currency = await getCurrencySettings(db);
  const decimalPlaces = getDecimalPlaces(currency.currencyCode);
  const result = await validateStorefrontCartItems(db, data.items, {
    inventoryPool: data.inventoryPool,
    currencyCode: currency.currencyCode,
  });
  if (!result.valid || !data.city || !data.zone) {
    return ok(c, presentStorefrontCartValidation(result, decimalPlaces));
  }

  const delivery = await validateStorefrontDeliveryPreflight(
    db,
    {
      city: data.city,
      zone: data.zone,
      area: data.area,
      shippingMethodId: data.shippingMethodId,
    },
    result,
  );
  return ok(c, {
    ...presentStorefrontCartValidation(result, decimalPlaces),
    delivery: presentStorefrontDeliveryPreflight(delivery, decimalPlaces),
  });
});

type TaxQuoteCartValidationResult = Awaited<ReturnType<typeof validateStorefrontCartItems>>;
type TaxQuoteDeliveryResult = Awaited<ReturnType<typeof validateStorefrontDeliveryPreflight>>;

async function resolveAuthoritativeTaxQuote(
  db: Database,
  input: {
    discountCode?: string | null;
    customerPhone?: string | null;
    customerId?: string | null;
  },
  cartValidation: TaxQuoteCartValidationResult,
  delivery: TaxQuoteDeliveryResult,
  destination: { city: string; zone: string; area?: string | null },
  currencyCode: string,
): Promise<{ quote: TaxQuote; offers: string[] }> {
  const discountCode = input.discountCode?.trim() || null;
  if (discountCode && !input.customerPhone) {
    throw new ValidationError("A customer phone number is required to quote this discount.");
  }
  const decimalPlaces = getDecimalPlaces(currencyCode);
  const discount = await quoteStorefrontDiscount(db, {
    code: discountCode,
    customerId: input.customerId,
    customerPhone: input.customerPhone,
    cart: {
      currencyCode,
      lines: cartValidation.items.map((item) => ({
        id: buildStorefrontTaxAllocationLineId(item.index, item.variantId),
        productId: item.productId,
        variantId: item.variantId,
        unitPriceMinor: item.unitPriceMinor,
        quantity: item.quantity,
      })),
      shippingAmountMinor: delivery.shippingMinor,
    },
  });

  const quote = await calculateStorefrontTaxQuote(db, {
    destination: {
      city: destination.city,
      zone: destination.zone,
      area: destination.area ?? null,
      cityName: delivery.cityName,
      zoneName: delivery.zoneName,
      areaName: delivery.areaName,
    },
    lines: cartValidation.items.map((item) => ({
      lineId: buildStorefrontTaxAllocationLineId(item.index, item.variantId),
      productId: item.productId,
      variantId: item.variantId,
      unitPriceMinor: item.unitPriceMinor,
      quantity: item.quantity,
      taxClassId: item.taxClassId,
    })),
    shippingMinor: delivery.shippingMinor,
    promotionDiscountAllocation: discount.taxAllocation,
    currency: { code: currencyCode, decimalPlaces },
  });
  return { quote, offers: discount.offers };
}

app.openapi(taxQuoteRoute, async (c) => {
  const db = c.get("db");
  const data = c.req.valid("json");
  const customerSessionToken = getCustomerSessionTokenFromRequest(c);
  const sessionCustomer = customerSessionToken && data.discountCode?.trim()
    ? await getCustomerBySession(
        db,
        customerSessionToken,
        getCustomerSessionHashKey(c.env as unknown as Record<string, unknown>),
      )
    : null;
  const currency = await getCurrencySettings(db);
  const cartValidation = await validateStorefrontCartItems(db, data.items, {
    inventoryPool: data.inventoryPool,
    currencyCode: currency.currencyCode,
  });
  if (!cartValidation.valid) {
    throw new ValidationError("Some items in your cart need attention.", {
      itemIssues: cartValidation.issues,
    });
  }
  const delivery = await validateStorefrontDeliveryPreflight(db, {
    city: data.city,
    zone: data.zone,
    area: data.area,
    shippingMethodId: data.shippingMethodId,
  }, cartValidation);
  const { quote, offers } = await resolveAuthoritativeTaxQuote(
    db,
    {
      discountCode: data.discountCode,
      customerPhone: data.customerPhone,
      customerId: sessionCustomer?.customerId ?? null,
    },
    cartValidation,
    delivery,
    data,
    currency.currencyCode,
  );
  const toAmount = (minor: number) => fromMinor(minor, quote.decimalPlaces);
  return ok(c, {
    valid: true as const,
    quoteFingerprint: await buildStorefrontCheckoutQuoteFingerprint(
      quote,
      delivery.shippingMethod,
    ),
    displayLabel: quote.displayLabel,
    pricesIncludeTax: quote.pricesIncludeTax,
    shippingTaxed: quote.shippingTaxed,
    currencyCode: quote.currencyCode,
    decimalPlaces: quote.decimalPlaces,
    settingsVersion: quote.settingsVersion,
    subtotalMinor: quote.subtotalMinor,
    subtotalAmount: toAmount(quote.subtotalMinor),
    shippingMinor: quote.shippingMinor,
    shippingAmount: toAmount(quote.shippingMinor),
    discountMinor: quote.discountMinor,
    discountAmount: toAmount(quote.discountMinor),
    taxMinor: quote.taxMinor,
    taxAmount: toAmount(quote.taxMinor),
    totalMinor: quote.totalMinor,
    totalAmount: toAmount(quote.totalMinor),
    shippingMethod: delivery.shippingMethod,
    discountOffers: offers,
    items: cartValidation.items.map((item) => ({
      cartKey: item.cartKey ?? null,
      productId: item.productId,
      variantId: item.variantId,
      quantity: item.quantity,
      unitPrice: toAmount(item.unitPriceMinor),
      productName: item.productName,
      variantLabel: item.variantLabel,
    })),
  });
});

const createOrderSchema = z.object({
  checkoutRequestId: z
    .string()
    .trim()
    .min(16, "Checkout request id is required")
    .max(128, "Checkout request id is too long")
    .regex(/^[A-Za-z0-9:_-]+$/, "Checkout request id contains unsupported characters"),
  expectedQuoteFingerprint: z
    .string()
    .regex(/^taxq_[A-Za-z0-9_-]{22}$/, "A current reviewed checkout quote is required")
    .openapi({
      description: "Exact authoritative quote fingerprint reviewed by the buyer before submitting the order.",
    }),
  customerName: z
    .string()
    .min(3, "Customer name must be at least 3 characters")
    .max(100, "Customer name must be less than 100 characters"),
  customerPhone: phoneNumberSchema,
  customerEmail: z.email().nullable(),
  shippingAddress: z
    .string()
    .min(10, "Address must be at least 10 characters")
    .max(500, "Address must be less than 500 characters"),
  city: z.string().min(1, "City is required"),
  zone: z.string().min(1, "Zone is required"),
  area: z.string().nullable(),
  cityName: z.string().nullable().optional(),
  zoneName: z.string().nullable().optional(),
  areaName: z.string().nullable().optional(),
  notes: z
    .string()
    .max(500, "Notes must be less than 500 characters")
    .nullable(),
  items: z.array(
    z.object({
      cartKey: z.string().min(1).max(256).optional().nullable(),
      productId: z.string().min(1, "Product is required"),
      variantId: persistedStorefrontVariantIdSchema,
      quantity: z.number().int("Quantity must be a whole number").min(1, "Quantity must be at least 1").max(99, "Quantity must be at most 99"),
      price: z.number().min(0, "Price must be greater than or equal to 0"),
      productName: z.string().optional().nullable(),
      variantLabel: z.string().optional().nullable()
    }),
  ).min(1, "At least one item is required"),
  discountAmount: z
    .number()
    .min(0, "Discount must be greater than or equal to 0")
    .nullable(),
  discountCode: z.string().optional().nullable(),
  shippingCharge: z
    .number()
    .min(0, "Shipping charge must be greater than or equal to 0"),
  shippingMethodId: z.string().optional().nullable(),
  paymentMethod: z
    .enum(listPaymentMethodIds() as [string, ...string[]])
    .default(PaymentMethod.COD),
  inventoryPool: z
    .enum([InventoryPool.REGULAR, InventoryPool.PREORDER, InventoryPool.BACKORDER])
    .default(InventoryPool.REGULAR)
});

type CreateOrderInput = z.infer<typeof createOrderSchema>;

function assertGatewayCurrencyReadiness(data: CreateOrderInput, currencyCode: string): void {
  if (!isOnlinePaymentMethod(data.paymentMethod)) return;
  const issue = getPaymentMethodCurrencyIssue(data.paymentMethod, currencyCode);
  if (issue) throw new ValidationError(issue);
}

function assertGatewayPrecommitReadiness(
  data: CreateOrderInput,
  checkoutSettings: CheckoutSettingsSnapshot,
  totalAmountMinor: number,
  currencyCode: string,
): void {
  const issue = getCheckoutGatewayPrecommitIssue({
    paymentMethod: data.paymentMethod,
    currencyCode,
    totalAmountMinor,
    partialPaymentEnabled: checkoutSettings.partialPaymentEnabled,
    partialPaymentAmount: checkoutSettings.partialPaymentAmount,
  });
  if (issue) throw new ValidationError(issue);
}

const checkoutCreatedPayloadSchema = z.object({
  checkoutToken: z.string(),
  receiptToken: z.string(),
  statusToken: z.string(),
  orderId: z.string(),
  paymentMethod: z.string(),
  totalAmount: z.number(),
  totalAmountMinor: z.number().int(),
  taxAmount: z.number(),
  taxAmountMinor: z.number().int(),
  taxLabel: z.string(),
  pricesIncludeTax: z.boolean(),
  currencyCode: z.string(),
  decimalPlaces: z.number().int(),
  message: z.string(),
});

type CheckoutCreatedPayload = z.infer<typeof checkoutCreatedPayloadSchema>;

const createOrderRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Orders"],
  summary: "Create a new storefront order",
  request: {
    body: {
      content: {
        "application/json": {
          schema: createOrderSchema
        }
      }
    }
  },
  responses: {
    201: {
      description: "Order created",
      content: { "application/json": { schema: z.object({
        success: z.literal(true),
        data: checkoutCreatedPayloadSchema,
      }) } },
    },
    202: {
      description: "Order submit is already processing",
      content: { "application/json": { schema: z.object({
        success: z.literal(true),
        data: z.object({
          statusToken: z.string(),
          orderId: z.string(),
          status: z.literal("processing"),
          message: z.string(),
        }),
      }) } },
    },
    400: errorResponses[400],
    401: errorResponses[401],
    409: conflictResponse,
    429: errorResponses[429],
    500: errorResponses[500],
    503: serviceUnavailableResponse,
  }
});

app.openapi(createOrderRoute, async (c) => {
  const db = c.get("db");
  const data = c.req.valid("json");
  const requestUrl = c.req.url;
  const diagnostics = createCheckoutDiagnostics(c.env);

  try {
    const attemptIdentity = await buildCheckoutAttemptIdentity(data);
    // One read round trip: idempotency row, checkout authority, and the rows
    // the commit needs. A committed request replays before any policy check.
    const checkoutReads = await loadStorefrontCheckoutReads<CheckoutCreatedPayload>(
      db,
      attemptIdentity,
      {
        items: data.items.map((item) => ({
          cartKey: item.cartKey,
          productId: item.productId,
          variantId: item.variantId,
          quantity: item.quantity,
          price: item.price,
          productName: item.productName,
          variantLabel: item.variantLabel,
        })),
        inventoryPool: data.inventoryPool,
        city: data.city,
        zone: data.zone,
        area: data.area,
        shippingMethodId: data.shippingMethodId,
        customerEmail: data.customerEmail,
        customerPhone: data.customerPhone,
      },
      getCredentialEncryptionKey(c.env as Record<string, unknown>),
    );
    const existingAttempt = checkoutReads.existingAttempt;
    diagnostics?.mark("attempt");

    if (existingAttempt?.status === "replay") {
      return created(c, existingAttempt.response);
    }

    if (existingAttempt?.status === "processing") {
      return c.json({
        success: true,
        data: {
          statusToken: existingAttempt.statusToken,
          orderId: existingAttempt.orderId,
          status: "processing" as const,
          message: "Order creation is already processing.",
        },
      }, 202);
    }
    const retryAttempt = existingAttempt?.status === "retry"
      ? existingAttempt.attempt
      : null;

    const checkoutAuthority = checkoutReads.authority();
    const { currency, cartValidation, deliveryPreflight } = checkoutAuthority;
    diagnostics?.mark("authority");

    const {
      customerIdentity: checkoutCustomerIdentity,
      checkoutSettings,
    } = await assertCheckoutOrderPolicy(
      c,
      data.customerPhone,
      data.paymentMethod as CheckoutPaymentMethodId,
      checkoutAuthority,
    );
    assertGatewayCurrencyReadiness(data, currency.currencyCode);
    diagnostics?.mark("policy");

    // This remains memory-only until the authoritative order batch. The
    // idempotency row, order, inventory mutation, and receipt either all commit
    // or all roll back together.
    const checkoutAttempt = retryAttempt ?? createAtomicCheckoutAttempt(attemptIdentity);

    const result = await createStorefrontOrder(
      db,
      data,
      requestUrl,
      {
        orderId: checkoutAttempt.orderId,
        checkoutToken: checkoutAttempt.checkoutToken,
      },
      cartValidation,
      deliveryPreflight,
      checkoutCustomerIdentity ?? undefined,
      {
        code: currency.currencyCode,
        decimalPlaces: getDecimalPlaces(currency.currencyCode),
      },
      createTrustedStorefrontCheckoutPolicySnapshot({
        partialPaymentEnabled: checkoutSettings.partialPaymentEnabled,
        authorityRevision: checkoutAuthority.authorityRevision,
        orderCreatedNotificationEnabled:
          checkoutAuthority.sideEffects.orderCreatedNotification,
        metaPurchaseEnabled: checkoutAuthority.sideEffects.metaPurchase,
      }),
      checkoutAuthority.taxAuthority,
    );

    assertStorefrontCheckoutQuoteFingerprint(
      data.expectedQuoteFingerprint,
      await buildStorefrontCheckoutQuoteFingerprint(
        result.taxQuote,
        deliveryPreflight.shippingMethod,
      ),
    );

    assertGatewayPrecommitReadiness(
      data,
      checkoutSettings,
      result.taxQuote.totalMinor,
      currency.currencyCode,
    );
    diagnostics?.mark("prepare");

    // Only authoritative, policy-valid checkouts consume buyer rate-limit
    // budget. All database writes still remain in the single commit below.
    await enforceCheckoutRateLimits(c.env, c.req.raw, data.customerPhone);
    diagnostics?.mark("rate_limit");

    const executionCtx = getOptionalExecutionContext(c);

    const responsePayload: CheckoutCreatedPayload = {
      checkoutToken: result.checkoutToken,
      receiptToken: result.checkoutToken,
      statusToken: checkoutAttempt.statusToken,
      orderId: result.orderId,
      paymentMethod: result.paymentMethod,
      totalAmount: fromMinor(result.taxQuote.totalMinor, result.taxQuote.decimalPlaces),
      totalAmountMinor: result.taxQuote.totalMinor,
      taxAmount: fromMinor(result.taxQuote.taxMinor, result.taxQuote.decimalPlaces),
      taxAmountMinor: result.taxQuote.taxMinor,
      taxLabel: result.taxQuote.displayLabel,
      pricesIncludeTax: result.taxQuote.pricesIncludeTax,
      currencyCode: result.taxQuote.currencyCode,
      decimalPlaces: result.taxQuote.decimalPlaces,
      message: "Order created",
    };

    let availabilityTransitionVariantIds: string[];
    try {
      ({ availabilityTransitionVariantIds } = await commitStorefrontOrderPayload(
        db,
        result.commitPayload,
        { attempt: checkoutAttempt, response: responsePayload },
        checkoutReads.commitReads,
      ));
    } catch (commitError) {
      const recoveredAttempt = await resolveExistingCheckoutAttempt<typeof responsePayload>(
        db,
        attemptIdentity,
      ).catch((recoveryError: unknown) => {
        console.warn("[Orders] Failed to resolve checkout after an uncertain commit:", recoveryError);
        return null;
      });
      if (recoveredAttempt?.status === "replay") {
        scheduleCheckoutSuccessRecoveryHints(
          c.env,
          recoveredAttempt.response.statusToken,
          recoveredAttempt.response.receiptToken,
          recoveredAttempt.response.orderId,
          executionCtx,
        );
        return created(c, recoveredAttempt.response);
      }
      if (recoveredAttempt?.status === "processing") {
        return c.json({
          success: true,
          data: {
            statusToken: recoveredAttempt.statusToken,
            orderId: recoveredAttempt.orderId,
            status: "processing" as const,
            message: "Order creation is already processing.",
          },
        }, 202);
      }
      scheduleCheckoutFailureStatusHint(
        c.env,
        checkoutAttempt.statusToken,
        result.orderId,
        commitError instanceof ValidationError
          ? commitError.message
          : "Order creation failed. Please try again.",
        executionCtx,
      );
      throw commitError;
    }
    diagnostics?.mark("commit");

    scheduleCheckoutSuccessRecoveryHints(
      c.env,
      checkoutAttempt.statusToken,
      result.checkoutToken,
      result.orderId,
      executionCtx,
    );

    const postCommit = Promise.all([
      availabilityTransitionVariantIds.length > 0 ? bumpCacheGeneration(c) : null,
      runStorefrontOrderPostCommitSideEffects(db, c.env, result.commitPayload),
    ]);
    if (executionCtx && typeof executionCtx.waitUntil === "function") {
      executionCtx.waitUntil(postCommit);
    } else {
      await postCommit;
    }

    diagnostics?.mark("post_commit");
    diagnostics?.apply(c);

    return created(c, responsePayload);
  } catch (error: unknown) {
    if (error instanceof z.ZodError) {
      throw new ValidationError("Invalid input data", error.issues);
    }

    throw error;
  }
});

// Export the order routes
export { app as orderRoutes };
