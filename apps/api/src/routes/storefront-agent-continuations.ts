import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import { orders } from "@scalius/database/schema";
import {
  assertHostedContinuationOrderAccess,
  bindAgentStorefrontCustomerSession,
  bindAgentStorefrontRecoveredOrder,
  claimAgentStorefrontContinuationBootstrap,
  getHostedAgentStorefrontContinuation,
  getHostedAgentStorefrontContinuationStatus,
  getLatestPaymentAttemptId,
  markAgentStorefrontPaymentContinuationStarted,
  refreshAgentStorefrontPaymentContinuation,
} from "@scalius/core/modules/agent-storefront";
import {
  buildSetCookieHeader,
  deleteCustomerAuthOtpChallenge,
  deleteCustomerSession,
  getCookieConfig,
  hashCustomerSessionToken,
  sendOtp,
  SESSION_TTL_SECONDS,
  verifyOtp,
} from "@scalius/core/modules/customers/customer-auth.service";
import {
  deleteOrderPaymentRecoveryChallenge,
  sendOrderPaymentRecoveryOtp,
  verifyOrderPaymentRecoveryOtp,
} from "@scalius/core/modules/orders";
import { CUSTOMER_AUTH_OTP_CHANNELS } from "@scalius/shared/customer-auth-policy";
import { exchangeThemePreviewContinuation } from "@scalius/core/modules/settings/site-settings.service";
import { authMiddleware } from "../middleware/auth";
import {
  ForbiddenError,
  RateLimitError,
  ServiceUnavailableError,
  ValidationError,
} from "../utils/api-error";
import { ok } from "../utils/api-response";
import { getTrustedClientIp } from "../utils/client-ip";
import {
  getCredentialEncryptionKey,
  getCustomerSessionHashKey,
  getEncryptionKey,
} from "../utils/encryption-key";
import {
  conflictResponse,
  errorResponses,
  serviceUnavailableResponse,
  successEnvelope,
} from "../schemas/responses";
import {
  createAgentContextPaymentSession,
  isPaymentSessionProcessingResult,
} from "./payment/payment-session-create";
import { acceptedPaymentSessionProcessing, paymentSessionProcessingResponse } from "./payment/payment-session-response";
import { reconcileStripeOrderPayment } from "./payment/stripe-reconciliation";
import { reconcilePolarOrderPayment } from "./payment/polar-reconciliation";

const app = new OpenAPIHono<{ Bindings: Env }>();

app.use("*", authMiddleware);

const continuationIdSchema = z.string().regex(/^acn_[A-Za-z0-9_-]{20}$/);
const continuationBootstrapCodeSchema = z.string().length(68)
  .regex(/^acb_[A-Za-z0-9_-]{20}_[A-Za-z0-9_-]{43}$/);
const themePreviewContinuationIdSchema = z.string().length(52).regex(/^tpc_[A-Za-z0-9_-]{48}$/);
const GENERIC_RECOVERY_MESSAGE =
  "If this order is eligible, a verification code will be sent to the buyer contact.";
const continuationPathSchema = z.object({ continuationId: continuationIdSchema });
const channelSchema = z.enum(CUSTOMER_AUTH_OTP_CHANNELS);
const continuationErrors = {
  400: errorResponses[400],
  401: errorResponses[401],
  403: errorResponses[403],
  404: errorResponses[404],
  409: conflictResponse,
  500: errorResponses[500],
};

const customerAuthInputSchema = z.object({
  method: z.enum(["email", "phone"]),
  channel: channelSchema.optional(),
  intent: z.enum(["sign_in", "sign_up"]).default("sign_in"),
  identifier: z.string().trim().min(3).max(254),
  name: z.string().trim().min(1).max(100).optional(),
  phone: z.string().trim().max(32).optional(),
  email: z.email().optional(),
}).strict();

function privateNoStore(c: { header(name: string, value: string, options?: { append?: boolean }): void }): void {
  c.header("Cache-Control", "private, no-cache, no-store, must-revalidate");
  c.header("Pragma", "no-cache");
  c.header("Expires", "0");
  c.header("Referrer-Policy", "no-referrer");
}

function assertKind<T extends "customer_auth" | "payment" | "payment_recovery">(
  actual: string,
  expected: T,
): asserts actual is T {
  if (actual !== expected) throw new ForbiddenError("This secure storefront step has a different purpose.");
}

const exchangeThemePreviewRoute = createRoute({
  method: "post",
  path: "/theme-preview",
  operationId: "system.storefront_continuations.theme_preview_exchange",
  tags: ["Internal Storefront Continuations"],
  summary: "Consume a one-time theme preview continuation for the storefront",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({
            continuationCode: themePreviewContinuationIdSchema,
          }).strict(),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Cookie-only preview bearer for the trusted storefront bridge",
      content: {
        "application/json": {
          schema: successEnvelope(z.object({
            token: z.string().length(52).regex(/^tpv_[A-Za-z0-9_-]{48}$/),
            draftRevision: z.number().int().positive(),
            basePublishedRevision: z.number().int().nonnegative(),
            expiresAt: z.any(),
          })),
        },
      },
    },
    ...continuationErrors,
  },
});
app.openapi(exchangeThemePreviewRoute, async (c) => {
  privateNoStore(c);
  const preview = await exchangeThemePreviewContinuation(
    c.get("db"),
    c.req.valid("json").continuationCode,
  );
  return ok(c, {
    token: preview.token,
    draftRevision: preview.draftRevision,
    basePublishedRevision: preview.basePublishedRevision,
    expiresAt: preview.expiresAt,
  });
});

const claimContinuationBootstrapRoute = createRoute({
  method: "post",
  path: "/bootstrap",
  operationId: "system.storefront_continuations.bootstrap_claim",
  tags: ["Internal Storefront Continuations"],
  summary: "Consume a one-time storefront continuation bootstrap code",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({
            continuationCode: continuationBootstrapCodeSchema,
          }).strict(),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Claimed browser-only continuation identity",
      content: {
        "application/json": {
          schema: successEnvelope(z.object({
            id: continuationIdSchema,
            kind: z.enum(["customer_auth", "payment", "payment_recovery"]),
            expiresAt: z.string(),
          })),
        },
      },
    },
    ...continuationErrors,
  },
});
app.openapi(claimContinuationBootstrapRoute, async (c) => {
  privateNoStore(c);
  return ok(c, await claimAgentStorefrontContinuationBootstrap(
    c.get("db"),
    c.req.valid("json").continuationCode,
  ));
});

const getContinuationRoute = createRoute({
  method: "get",
  path: "/{continuationId}",
  operationId: "system.storefront_continuations.get",
  tags: ["Internal Storefront Continuations"],
  summary: "Load a service-authenticated secure storefront continuation",
  security: [{ bearerAuth: [] }],
  request: { params: continuationPathSchema },
  responses: {
    200: { description: "Secure workflow bootstrap", content: { "application/json": { schema: successEnvelope(z.object({
      id: continuationIdSchema,
      kind: z.enum(["customer_auth", "payment", "payment_recovery"]),
      status: z.enum(["pending", "complete", "expired", "failed"]),
      expiresAt: z.string(),
    })) } } },
    ...continuationErrors,
  },
});
app.openapi(getContinuationRoute, async (c) => {
  privateNoStore(c);
  const continuationId = c.req.valid("param").continuationId;
  await refreshAgentStorefrontPaymentContinuation(c.get("db"), continuationId);
  const { orderId: _orderId, ...status } = await getHostedAgentStorefrontContinuationStatus(
    c.get("db"),
    continuationId,
  );
  return ok(c, status);
});

const sendCustomerOtpRoute = createRoute({
  method: "post",
  path: "/{continuationId}/customer/send-otp",
  operationId: "system.storefront_continuations.customer_auth_send_otp",
  tags: ["Internal Storefront Continuations"],
  summary: "Send a customer OTP inside a secure storefront continuation",
  security: [{ bearerAuth: [] }],
  request: {
    params: continuationPathSchema,
    body: { required: true, content: { "application/json": { schema: customerAuthInputSchema } } },
  },
  responses: {
    200: { description: "OTP delivery accepted", content: { "application/json": { schema: successEnvelope(z.object({ message: z.string() })) } } },
    503: serviceUnavailableResponse,
    ...continuationErrors,
  },
});
app.openapi(sendCustomerOtpRoute, async (c) => {
  privateNoStore(c);
  const continuation = await getHostedAgentStorefrontContinuation(c.get("db"), c.req.valid("param").continuationId);
  assertKind(continuation.kind, "customer_auth");
  const body = c.req.valid("json");
  const identifier = body.identifier.trim().toLowerCase();
  const result = await sendOtp(c.get("db"), {
    method: body.method,
    channel: body.channel,
    intent: body.intent,
    identifier,
    name: body.name?.trim() || "Customer",
    phone: body.phone?.trim(),
    email: body.email?.trim().toLowerCase(),
    ip: getTrustedClientIp(c),
    emailEnv: c.env as unknown as Record<string, unknown>,
    encryptionKey: getEncryptionKey(c.env as unknown as Record<string, unknown>),
    credentialEncryptionKey: getCredentialEncryptionKey(c.env as unknown as Record<string, unknown>),
    migrationEncryptionKey: getCredentialEncryptionKey(c.env as unknown as Record<string, unknown>),
  });
  if (!result.success) {
    if (result.httpStatus === 429) throw new RateLimitError(result.error || "Too many requests.");
    if (result.httpStatus === 403) throw new ForbiddenError(result.error || "This verification method is disabled.");
    throw new ValidationError(result.error || "Verification could not be started.");
  }
  if (result.queuePayload) {
    try {
      await c.env.AUTH_OTP_QUEUE.send(result.queuePayload);
    } catch (error) {
      if (result.otpStorageKey && result.deliveryKey) {
        await deleteCustomerAuthOtpChallenge(c.get("db"), {
          otpKey: result.otpStorageKey,
          deliveryKey: result.deliveryKey,
        }).catch(() => undefined);
      }
      console.error("[AgentContinuation] Customer OTP queue handoff failed:", error instanceof Error ? error.message : "unknown");
      throw new ServiceUnavailableError("Could not queue verification code delivery. Please try again.");
    }
  }
  return ok(c, { message: result.message || "Verification code sent." });
});

const verifyCustomerOtpRoute = createRoute({
  method: "post",
  path: "/{continuationId}/customer/verify-otp",
  operationId: "system.storefront_continuations.customer_auth_verify_otp",
  tags: ["Internal Storefront Continuations"],
  summary: "Verify a customer OTP and bind the resulting session to its context",
  security: [{ bearerAuth: [] }],
  request: {
    params: continuationPathSchema,
    body: { required: true, content: { "application/json": { schema: customerAuthInputSchema.extend({ code: z.string().trim().min(4).max(12) }) } } },
  },
  responses: {
    200: { description: "Customer authorized", content: { "application/json": { schema: successEnvelope(z.object({
      authenticated: z.literal(true),
      customer: z.object({}).passthrough().optional(),
      isNewUser: z.boolean(),
    })) } } },
    ...continuationErrors,
  },
});
app.openapi(verifyCustomerOtpRoute, async (c) => {
  privateNoStore(c);
  const continuationId = c.req.valid("param").continuationId;
  const continuation = await getHostedAgentStorefrontContinuation(c.get("db"), continuationId);
  assertKind(continuation.kind, "customer_auth");
  const body = c.req.valid("json");
  const sessionHashKey = getCustomerSessionHashKey(c.env as unknown as Record<string, unknown>);
  const result = await verifyOtp(c.get("db"), {
    method: body.method,
    channel: body.channel,
    intent: body.intent,
    identifier: body.identifier.trim().toLowerCase(),
    code: body.code.trim(),
    name: body.name?.trim() || "Customer",
    phone: body.phone?.trim(),
    email: body.email?.trim().toLowerCase(),
    encryptionKey: getEncryptionKey(c.env as unknown as Record<string, unknown>),
    credentialEncryptionKey: getCredentialEncryptionKey(c.env as unknown as Record<string, unknown>),
    sessionHashKey,
  });
  if (!result.success || !result.session) {
    if (result.httpStatus === 429) throw new RateLimitError(result.error || "Too many attempts.");
    throw new ValidationError(result.error || "Verification code is invalid.", {
      ...(result.attemptsLeft === undefined ? {} : { attemptsLeft: result.attemptsLeft }),
    });
  }
  const sessionToken = result.session.token;
  try {
    await bindAgentStorefrontCustomerSession(
      c.get("db"),
      continuationId,
      await hashCustomerSessionToken(sessionToken, sessionHashKey),
    );
  } catch (error) {
    await deleteCustomerSession(c.get("db"), sessionToken, sessionHashKey).catch(() => undefined);
    throw error;
  }
  const { sameSite, domainAttr } = getCookieConfig(c.env.STOREFRONT_URL, c.env.CUSTOMER_AUTH_COOKIE_DOMAIN);
  c.header("Set-Cookie", buildSetCookieHeader(sessionToken, SESSION_TTL_SECONDS, domainAttr, sameSite));
  c.header("Set-Cookie", `cs_auth=1; Max-Age=${SESSION_TTL_SECONDS}; Path=/${domainAttr}; SameSite=${sameSite}; Secure`, { append: true });
  return ok(c, { authenticated: true as const, customer: result.customer, isNewUser: Boolean(result.isNewUser) });
});

const startPaymentRoute = createRoute({
  method: "post",
  path: "/{continuationId}/payment/start",
  operationId: "system.storefront_continuations.payment_start",
  tags: ["Internal Storefront Continuations"],
  summary: "Start a payment session in the buyer-only secure storefront tab",
  security: [{ bearerAuth: [] }],
  request: {
    params: continuationPathSchema,
    body: { required: true, content: { "application/json": { schema: z.object({}).strict() } } },
  },
  responses: {
    200: { description: "Buyer-only payment session", content: { "application/json": { schema: successEnvelope(z.object({}).passthrough()) } } },
    202: paymentSessionProcessingResponse,
    503: serviceUnavailableResponse,
    ...continuationErrors,
  },
});
app.openapi(startPaymentRoute, async (c) => {
  privateNoStore(c);
  const continuationId = c.req.valid("param").continuationId;
  const access = await assertHostedContinuationOrderAccess(c.get("db"), continuationId);
  const session = await createAgentContextPaymentSession(c, { ...access, continuationId });
  await markAgentStorefrontPaymentContinuationStarted(
    c.get("db"),
    continuationId,
    await getLatestPaymentAttemptId(c.get("db"), access.orderId),
  );
  return isPaymentSessionProcessingResult(session)
    ? acceptedPaymentSessionProcessing(c, session)
    : ok(c, session);
});

const reconcilePaymentRoute = createRoute({
  method: "post",
  path: "/{continuationId}/payment/reconcile",
  operationId: "system.storefront_continuations.payment_reconcile",
  tags: ["Internal Storefront Continuations"],
  summary: "Reconcile a provider-confirmed payment inside the buyer-only tab",
  security: [{ bearerAuth: [] }],
  request: {
    params: continuationPathSchema,
    body: { required: true, content: { "application/json": { schema: z.object({}).strict() } } },
  },
  responses: {
    200: { description: "Provider reconciliation state", content: { "application/json": { schema: successEnvelope(z.object({
      status: z.enum(["pending", "scheduled", "settled"]),
      providerStatus: z.string().nullable(),
    })) } } },
    202: { description: "Confirmed payment scheduled for settlement", content: { "application/json": { schema: successEnvelope(z.object({
      status: z.literal("scheduled"),
      providerStatus: z.string().nullable(),
    })) } } },
    503: serviceUnavailableResponse,
    ...continuationErrors,
  },
});
app.openapi(reconcilePaymentRoute, async (c) => {
  privateNoStore(c);
  const access = await assertHostedContinuationOrderAccess(
    c.get("db"),
    c.req.valid("param").continuationId,
  );
  const order = await c.get("db").select({ paymentMethod: orders.paymentMethod })
    .from(orders).where(eq(orders.id, access.orderId)).get();
  const reconciliation = order?.paymentMethod === "polar"
    ? await reconcilePolarOrderPayment({ db: c.get("db"), env: c.env, orderId: access.orderId })
    : await reconcileStripeOrderPayment({ db: c.get("db"), env: c.env, orderId: access.orderId });
  const { data, accepted } = reconciliation;
  return accepted
    ? c.json({ success: true as const, data: {
      status: "scheduled" as const,
      providerStatus: data.providerStatus,
    } }, 202)
    : ok(c, data);
});

const sendRecoveryOtpRoute = createRoute({
  method: "post",
  path: "/{continuationId}/recovery/send-otp",
  operationId: "system.storefront_continuations.payment_recovery_send_otp",
  tags: ["Internal Storefront Continuations"],
  summary: "Send buyer verification for payment recovery",
  security: [{ bearerAuth: [] }],
  request: {
    params: continuationPathSchema,
    body: { required: true, content: { "application/json": { schema: z.object({ channel: channelSchema.optional() }).strict() } } },
  },
  responses: {
    200: { description: "Recovery verification accepted", content: { "application/json": { schema: successEnvelope(z.object({ message: z.string(), channel: channelSchema.optional() })) } } },
    503: serviceUnavailableResponse,
    ...continuationErrors,
  },
});
app.openapi(sendRecoveryOtpRoute, async (c) => {
  privateNoStore(c);
  const continuation = await getHostedAgentStorefrontContinuation(c.get("db"), c.req.valid("param").continuationId);
  assertKind(continuation.kind, "payment_recovery");
  if (!continuation.orderId) throw new ValidationError("This recovery step does not identify an order.");
  const result = await sendOrderPaymentRecoveryOtp(c.get("db"), {
    orderId: continuation.orderId,
    channel: c.req.valid("json").channel,
    ip: getTrustedClientIp(c),
    emailEnv: c.env as unknown as Record<string, unknown>,
    encryptionKey: getEncryptionKey(c.env as unknown as Record<string, unknown>),
    credentialEncryptionKey: getCredentialEncryptionKey(c.env as unknown as Record<string, unknown>),
    migrationEncryptionKey: getCredentialEncryptionKey(c.env as unknown as Record<string, unknown>),
  });
  if (result.queuePayload) {
    try {
      await c.env.AUTH_OTP_QUEUE.send(result.queuePayload);
    } catch (error) {
      if (result.challengeKey && result.deliveryKey) {
        await deleteOrderPaymentRecoveryChallenge(c.get("db"), {
          challengeKey: result.challengeKey,
          deliveryKey: result.deliveryKey,
        }).catch(() => undefined);
      }
      console.error("[AgentContinuation] Recovery OTP queue handoff failed:", error instanceof Error ? error.message : "unknown");
      throw new ServiceUnavailableError("Could not queue verification code delivery. Please try again.");
    }
  }
  return ok(c, { message: GENERIC_RECOVERY_MESSAGE });
});

const verifyRecoveryOtpRoute = createRoute({
  method: "post",
  path: "/{continuationId}/recovery/verify-otp",
  operationId: "system.storefront_continuations.payment_recovery_verify_otp",
  tags: ["Internal Storefront Continuations"],
  summary: "Verify buyer recovery and bind order authority to its context",
  security: [{ bearerAuth: [] }],
  request: {
    params: continuationPathSchema,
    body: { required: true, content: { "application/json": { schema: z.object({
      channel: channelSchema,
      code: z.string().trim().min(4).max(12),
    }).strict() } } },
  },
  responses: {
    200: { description: "Recovery verified for trusted storefront proxy", content: { "application/json": { schema: successEnvelope(z.object({
      recovered: z.literal(true),
      orderId: z.string(),
      receiptProof: z.string(),
    })) } } },
    ...continuationErrors,
  },
});
app.openapi(verifyRecoveryOtpRoute, async (c) => {
  privateNoStore(c);
  const continuationId = c.req.valid("param").continuationId;
  const continuation = await getHostedAgentStorefrontContinuation(c.get("db"), continuationId);
  assertKind(continuation.kind, "payment_recovery");
  if (!continuation.orderId) throw new ValidationError("This recovery step does not identify an order.");
  const body = c.req.valid("json");
  const result = await verifyOrderPaymentRecoveryOtp(c.get("db"), {
    orderId: continuation.orderId,
    channel: body.channel,
    code: body.code,
    encryptionKey: getEncryptionKey(c.env as unknown as Record<string, unknown>),
  });
  await bindAgentStorefrontRecoveredOrder(c.get("db"), continuationId, {
    orderId: result.orderId,
    authorityExpiresAt: new Date(result.expiresAt * 1_000),
    gateway: result.gateway,
    paymentType: result.paymentType,
  });
  // This proof is consumed only by the authenticated same-origin storefront proxy,
  // which converts it to an HttpOnly cookie and strips it from the browser response.
  return ok(c, { recovered: true as const, orderId: result.orderId, receiptProof: result.receiptToken });
});

export const storefrontAgentContinuationRoutes = app;
