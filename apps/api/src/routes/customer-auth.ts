// src/server/routes/customer-auth.ts
// Customer-facing sign-in with one-time codes (email, SMS or WhatsApp).
//
// Endpoints (mounted at /api/v1/customer-auth):
//   POST /send-otp   — send a 6-digit code (5-min D1 challenge); never reveals accounts
//   POST /verify-otp — check the code; sign in (30-day D1 session cookie) or ask a
//                      new buyer for name/phone and create the account
//   GET  /me         — return session customer info (reads cookie)
//   POST /logout     — revoke D1 session, clear cookie
//   PUT  /profile    — update customer profile
//   GET  /orders     — return orders for authenticated customer
//
// Session storage: D1 customer_sessions table keyed by HMAC token hash.
// OTP challenges:  D1 table "customer_auth_otp_challenges", key prefix "cust_otp:"
// Cookie name:     "cs_tok" (httpOnly, Secure; host-only unless explicitly configured)

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import {
  sendOtp,
  verifyOtp,
  getCustomerBySession,
  deleteCustomerSession,
  updateCustomerProfile,
  getSessionCookie,
  getCookieConfig,
  buildSetCookieHeader,
  deleteCustomerAuthOtpChallenge,
  getAccountPhoneVerificationPrompt,
  sendAccountPhoneCode,
  verifyAccountPhoneCode,
  COOKIE_NAME,
  SESSION_TTL_SECONDS
} from "@scalius/core/modules/customers/customer-auth.service";
import {
  getCustomerOrderDetailForOrder,
  getCustomerOrders,
  getCustomerOwnedOrderForDetail,
  getCustomerPaymentSessionOrderForDetail,
} from "@scalius/core/modules/customers/customers.service";
import { claimGuestOrderToAccount } from "@scalius/core/modules/customers/order-account-claim";
import { linkVerifiedContactOrders } from "@scalius/core/modules/customers/customer-identity";
import { listOrderDiscountLines } from "@scalius/core/modules/promotions";
import { orderDiscountLineSchema, presentOrderDiscountLines } from "../schemas/storefront-discounts";
import { buyerOrderProgressSchema, buyerOrderTimelineSchema } from "../schemas/order-tracking";
import {
  createCustomerOrderSupportRequest,
  CUSTOMER_ORDER_SUPPORT_REQUEST_TYPES,
  getOrderSupportRequestStatusLabel,
} from "@scalius/core/modules/orders/order-support-requests";
import { CUSTOMER_AUTH_OTP_CHANNELS } from "@scalius/shared/customer-auth-policy";
import { UnauthorizedError, ServiceUnavailableError } from "../utils/api-error";
import {
  conflictResponse,
  errorResponses,
  messageResponse,
  serviceUnavailableResponse,
  successEnvelope,
} from "../schemas/responses";
import { nullableTimestampSchema } from "../schemas/timestamps";
import { created, ok } from "../utils/api-response";
import { getCredentialEncryptionKey, getCustomerSessionHashKey } from "../utils/encryption-key";
import { getTrustedClientIp } from "../utils/client-ip";
import {
  createCustomerAccountPaymentSession,
  isPaymentSessionProcessingResult,
  resolveCustomerPaymentSessionRecovery,
} from "./payment/payment-session-create";
import {
  acceptedPaymentSessionProcessing,
  paymentSessionProcessingResponse,
} from "./payment/payment-session-response";
import { enqueueOrderSupportRequestNotificationForOrder } from "../utils/order-notification-queue";
import { validateReceiptToken } from "../utils/order-receipt-token";

const app = new OpenAPIHono<{ Bindings: Env }>();
const customerAuthChannelSchema = z.enum(CUSTOMER_AUTH_OTP_CHANNELS);
const customerAuthProfileSchema = z.object({
  email: z.string(),
  name: z.string(),
  phone: z.string().nullable().optional(),
  customerId: z.string().nullable().optional(),
  address: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  zone: z.string().nullable().optional(),
  area: z.string().nullable().optional(),
  cityName: z.string().nullable().optional(),
  zoneName: z.string().nullable().optional(),
  areaName: z.string().nullable().optional(),
  profileComplete: z.boolean(),
});

function setPrivateNoStoreHeaders(c: Context) {
  c.header("Cache-Control", "private, no-cache, no-store, must-revalidate");
  c.header("Pragma", "no-cache");
  c.header("Expires", "0");
}

async function requireCustomerSession(c: Context<{ Bindings: Env }>) {
  const cookieHeader = c.req.header("Cookie") || null;
  const token = getSessionCookie(cookieHeader);

  if (!token) {
    throw new UnauthorizedError("Authentication required");
  }

  const session = await getCustomerBySession(
    c.get("db"),
    token,
    getCustomerSessionHashKey(c.env as unknown as Record<string, unknown>),
  );

  if (!session) {
    throw new UnauthorizedError("Session expired. Please log in again.");
  }

  return { session, token };
}

// ─── POST /send-otp ──────────────────────────────────────────────────────────

const otpContactSchema = {
  method: z.enum(["email", "phone"]).optional().default("email"),
  channel: customerAuthChannelSchema.optional(),
  identifier: z.string().trim().min(1).max(254).openapi({ description: "Email or phone number" }),
};

const sendOtpRoute = createRoute({
  method: "post",
  path: "/send-otp",
  tags: ["Customer Auth"],
  summary: "Send a sign-in code (the same call for new and returning buyers)",
  request: {
    body: {
      content: {
        "application/json": { schema: z.object(otpContactSchema) },
      },
    },
  },
  responses: {
    200: {
      description: "Code sent",
      content: {
        "application/json": {
          schema: successEnvelope(z.object({
            message: z.string(),
            resendAfterSeconds: z.number().int(),
          })),
        },
      },
    },
    ...errorResponses,
    503: serviceUnavailableResponse,
  },
});

app.openapi(sendOtpRoute, async (c) => {
  const body = c.req.valid("json");
  const db = c.get("db");
  const env = c.env as unknown as Record<string, unknown>;

  const result = await sendOtp(db, {
    method: body.method,
    channel: body.channel,
    identifier: body.identifier,
    ip: getTrustedClientIp(c),
    emailEnv: env,
    encryptionKey: getCredentialEncryptionKey(env),
    credentialEncryptionKey: getCredentialEncryptionKey(env),
  });

  try {
    await c.env.JOBS_QUEUE.send(result.queuePayload);
  } catch (error) {
    await deleteCustomerAuthOtpChallenge(db, {
      otpKey: result.otpStorageKey,
      deliveryKey: result.deliveryKey,
    }).catch((deleteError: unknown) => {
      console.error("[CustomerAuth] Failed to clear OTP challenge after queue handoff failure:", deleteError instanceof Error ? deleteError.name : typeof deleteError);
    });
    console.error("[CustomerAuth] Failed to enqueue OTP delivery:", error instanceof Error ? error.name : typeof error);
    throw new ServiceUnavailableError("We couldn't send the code. Please try again.");
  }

  return ok(c, { message: result.message, resendAfterSeconds: result.resendAfterSeconds });
});

// ─── POST /verify-otp ────────────────────────────────────────────────────────

const verifyOtpRoute = createRoute({
  method: "post",
  path: "/verify-otp",
  tags: ["Customer Auth"],
  summary: "Check a sign-in code; signs in, or asks a new buyer for their details",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            ...otpContactSchema,
            code: z.string().trim().min(4).max(12).openapi({ description: "6-digit code" }),
            account: z.object({
              name: z.string().trim().max(120),
              phone: z.string().trim().max(32).optional(),
              email: z.string().trim().max(254).optional(),
              saveOrderAddress: z.boolean().optional().openapi({
                description: "Save the delivery address of the latest order placed with the proven contact (from `suggestion.address`).",
              }),
            }).optional().openapi({ description: "Only for a new account, after status needs_account_details" }),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Signed in, or the code is right and a new account needs details",
      content: {
        "application/json": {
          schema: successEnvelope(z.object({
            status: z.enum(["signed_in", "needs_account_details"]),
            customer: customerAuthProfileSchema.optional(),
            isNewUser: z.boolean().optional(),
            suggestion: z.object({
              name: z.string().nullable(),
              phone: z.string().nullable(),
              email: z.string().nullable(),
              address: z.object({
                orderNumber: z.number().int().nullable(),
                text: z.string(),
              }).nullable(),
            }).nullable().optional().openapi({
              description: "With needs_account_details: what the latest order placed with the proven contact says, to pre-fill.",
            }),
          })),
        },
      },
    },
    ...errorResponses,
    503: serviceUnavailableResponse,
  },
});

app.openapi(verifyOtpRoute, async (c) => {
  const body = c.req.valid("json");
  const env = c.env as unknown as Record<string, unknown>;

  const result = await verifyOtp(c.get("db"), {
    method: body.method,
    channel: body.channel,
    identifier: body.identifier,
    code: body.code,
    account: body.account,
    encryptionKey: getCredentialEncryptionKey(env),
    sessionHashKey: getCustomerSessionHashKey(env),
  });
  if (result.status === "needs_account_details") {
    return ok(c, { status: result.status, suggestion: result.suggestion });
  }

  const { sameSite, domainAttr } = getCookieConfig(
    c.env.STOREFRONT_URL as string | undefined,
    c.env.CUSTOMER_AUTH_COOKIE_DOMAIN as string | undefined,
  );
  c.header("Set-Cookie", buildSetCookieHeader(result.session.token, SESSION_TTL_SECONDS, domainAttr, sameSite));
  c.header("Set-Cookie", `cs_auth=1; Max-Age=${SESSION_TTL_SECONDS}; Path=/${domainAttr}; SameSite=${sameSite}; Secure`, { append: true });

  return ok(c, {
    status: result.status,
    customer: result.customer,
    isNewUser: result.isNewUser,
  });
});

// ─── GET /me ─────────────────────────────────────────────────────────────────

const getMeRoute = createRoute({
  method: "get",
  path: "/me",
  tags: ["Customer Auth"],
  summary: "Get current customer session info",
  responses: {
    200: {
      description: "Customer session info",
      content: {
        "application/json": {
          schema: successEnvelope(z.object({
            authenticated: z.boolean(),
            customer: customerAuthProfileSchema.optional(),
          })),
        },
      },
    },
    ...errorResponses,
  },
});

app.openapi(getMeRoute, async (c) => {
  setPrivateNoStoreHeaders(c);

  const cookieHeader = c.req.header("Cookie") || null;
  const token = getSessionCookie(cookieHeader);

  if (!token) {
    return ok(c, { authenticated: false });
  }

  const session = await getCustomerBySession(
    c.get("db"),
    token,
    getCustomerSessionHashKey(c.env as unknown as Record<string, unknown>),
  );

  if (!session) {
    return ok(c, { authenticated: false });
  }

  const { token: _token, createdAt: _createdAt, expiresAt: _expiresAt, ...customer } = session;
  return ok(c, { authenticated: true, customer });
});

// ─── POST /logout ────────────────────────────────────────────────────────────

const logoutRoute = createRoute({
  method: "post",
  path: "/logout",
  tags: ["Customer Auth"],
  summary: "Logout and clear session",
  responses: {
    200: {
      description: "Logged out successfully",
      content: { "application/json": { schema: messageResponse } },
    },
    ...errorResponses,
  },
});

app.openapi(logoutRoute, async (c) => {
  const { sameSite, domainAttr } = getCookieConfig(
    c.env.STOREFRONT_URL as string | undefined,
    c.env.CUSTOMER_AUTH_COOKIE_DOMAIN as string | undefined,
  );

  // Always clear cookies first
  c.header("Set-Cookie", `${COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; SameSite=${sameSite}; Secure`);
  c.header("Set-Cookie", `cs_auth=; Max-Age=0; Path=/; SameSite=${sameSite}; Secure`, { append: true });

  // Domain-scoped clears
  if (domainAttr) {
    c.header("Set-Cookie", `${COOKIE_NAME}=; Max-Age=0; Path=/${domainAttr}; HttpOnly; SameSite=${sameSite}; Secure`, { append: true });
    c.header("Set-Cookie", `cs_auth=; Max-Age=0; Path=/${domainAttr}; SameSite=${sameSite}; Secure`, { append: true });
  }

  // Revoke D1 session (best-effort after cookie clear)
  try {
    const cookieHeader = c.req.header("Cookie") || null;
    const token = getSessionCookie(cookieHeader);
    if (token) {
      await deleteCustomerSession(
        c.get("db"),
        token,
        getCustomerSessionHashKey(c.env as unknown as Record<string, unknown>),
      );
    }
  } catch (error: unknown) {
    console.error("[CustomerAuth] D1 session revoke failed:", error);
  }

  return ok(c, { message: "Logged out successfully" });
});

// ─── PUT /profile ────────────────────────────────────────────────────────────

const updateProfileRoute = createRoute({
  method: "put",
  path: "/profile",
  tags: ["Customer Auth"],
  summary: "Update customer profile",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            name: z.string().optional(),
            address: z.string().optional(),
            city: z.string().optional(),
            zone: z.string().optional(),
            area: z.string().optional(),
            cityName: z.string().optional(),
            zoneName: z.string().optional(),
            areaName: z.string().optional()
          })
        }
      }
    }
  },
  responses: {
    200: {
      description: "Profile updated",
      content: {
        "application/json": {
          schema: successEnvelope(z.object({
            customer: customerAuthProfileSchema,
          })),
        },
      },
    },
    ...errorResponses,
  },
});

app.openapi(updateProfileRoute, async (c) => {
  const { session } = await requireCustomerSession(c);
  const body = c.req.valid("json");

  // A blank value is sent through so the service can reject a blank name
  // instead of silently keeping (or dropping) it.
  const updates: Record<string, string | undefined> = {};
  for (const field of ["name", "address", "city", "zone", "area"] as const) {
    if (body[field] !== undefined) updates[field] = body[field].trim();
  }

  const db = c.get("db");
  const result = await updateCustomerProfile(db, session, updates);

  return ok(c, {
    customer: result.customer,
  });
});

// ─── GET /orders ──────────────────────────────────────────────────────────────

const getCustomerOrdersRoute = createRoute({
  method: "get",
  path: "/orders",
  tags: ["Customer Auth"],
  summary: "Get orders for authenticated customer",
  request: {
    query: z.object({
      cursor: z.string().min(1).optional(),
      limit: z.coerce.number().int().min(1).max(50).optional(),
    }),
  },
  responses: {
    200: {
      description: "Customer orders list",
      content: {
        "application/json": {
          schema: successEnvelope(z.object({
            orders: z.array(z.object({
              id: z.string(),
              orderNumber: z.number().int().nullable(),
              invoiceNumber: z.number().nullable().optional(),
              status: z.string(),
              statusLabel: z.string(),
              openSupportRequestType: z.string().nullable(),
              currencyCode: z.string(),
              totalAmount: z.number(),
              paidAmount: z.number(),
              balanceDue: z.number(),
              shippingCharge: z.number(),
              shippingMethodId: z.string().nullable(),
              shippingMethodName: z.string().nullable(),
              shippingMethodDescription: z.string().nullable(),
              shippingMethodBaseAmountMinor: z.number().int().nullable(),
              shippingFeeWaived: z.boolean().nullable(),
              discountAmount: z.number().nullable(),
              paymentStatus: z.string(),
              paymentMethod: z.string(),
              fulfillmentStatus: z.string(),
              expectedDelivery: z.string().nullable().optional(),
              shippingAddress: z.string(),
              cityName: z.string().nullable(),
              zoneName: z.string().nullable(),
              areaName: z.string().nullable().optional(),
              notes: z.string().nullable(),
              createdAt: nullableTimestampSchema,
              latestShipment: z.object({
                id: z.string(),
                providerType: z.string(),
                providerName: z.string().nullable(),
                status: z.string(),
                rawStatus: z.string().nullable(),
                trackingId: z.string().nullable(),
                trackingUrl: z.string().nullable(),
                courierName: z.string().nullable(),
                statusLabel: z.string(),
                lastChecked: nullableTimestampSchema,
                updatedAt: nullableTimestampSchema,
                createdAt: nullableTimestampSchema,
              }).nullable().optional(),
              items: z.array(z.object({
                productId: z.string(),
                variantId: z.string().nullable(),
                quantity: z.number(),
                price: z.number(),
                productName: z.string().nullable(),
                productSlug: z.string().nullable(),
                productImage: z.string().nullable(),
                variantLabel: z.string().nullable(),
              }).passthrough()),
            }).passthrough()),
            summary: z.object({
              totalOrders: z.number(),
              totalSpent: z.number(),
              completedOrders: z.number(),
              pendingOrders: z.number(),
            }),
            pagination: z.object({
              limit: z.number(),
              returned: z.number(),
              hasMore: z.boolean(),
              nextCursor: z.string().nullable(),
            }),
            phoneVerification: z.object({
              phone: z.string().openapi({ description: "The account's own phone (E.164)" }),
            }).nullable().openapi({
              description: "Set when the account's own phone is unverified and a text/WhatsApp code can reach it. Proving it adds orders placed with that phone.",
            }),
            customer: z.object({
              id: z.string().optional(),
              name: z.string(),
              email: z.string().optional(),
              phone: z.string().optional(),
              address: z.string().nullable().optional(),
              cityName: z.string().nullable().optional(),
              zoneName: z.string().nullable().optional(),
              city: z.string().nullable().optional(),
              zone: z.string().nullable().optional(),
              area: z.string().nullable().optional(),
              areaName: z.string().nullable().optional(),
            }),
          })),
        },
      },
    },
    ...errorResponses,
  },
});

app.openapi(getCustomerOrdersRoute, async (c) => {
  setPrivateNoStoreHeaders(c);

  const { session } = await requireCustomerSession(c);
  const query = c.req.valid("query");

  // Build a fallback customer profile from session data
  const sessionProfile = {
    name: session.name || "Customer",
    email: session.email,
    phone: session.phone
  };

  // Match orders EXCLUSIVELY by customerId
  if (!session.customerId) {
    return ok(c, {
      orders: [],
      customer: sessionProfile,
      summary: {
        totalOrders: 0,
        totalSpent: 0,
        completedOrders: 0,
        pendingOrders: 0,
      },
      pagination: {
        limit: query.limit ?? 50,
        returned: 0,
        hasMore: false,
        nextCursor: null,
      },
      phoneVerification: null,
    });
  }

  const db = c.get("db");
  // Orders placed signed out (any device) with a verified email/phone join
  // the history here, not only at sign-in.
  await linkVerifiedContactOrders(db, session.customerId);
  const [result, phoneVerification] = await Promise.all([
    getCustomerOrders(db, session.customerId, query),
    getAccountPhoneVerificationPrompt(db, session.customerId, getCredentialEncryptionKey(c.env as unknown as Record<string, unknown>)),
  ]);

  // Merge session data into profile (DB profile wins, session fills gaps)
  const customer = result.customerProfile
    ? {
        ...result.customerProfile,
        name: result.customerProfile.name || session.name || "Customer",
        email: result.customerProfile.email || session.email,
        phone: result.customerProfile.phone || session.phone,
      }
    : sessionProfile;

  return ok(c, {
    orders: result.orders,
    customer,
    summary: result.summary,
    pagination: result.pagination,
    phoneVerification,
  });
});

// ─── The account's own phone, proven by code ─────────────────────────────────

const sendAccountPhoneCodeRoute = createRoute({
  method: "post",
  path: "/phone/send-code",
  tags: ["Customer Auth"],
  summary: "Send a code to the signed-in account's own phone",
  responses: {
    200: {
      description: "Code sent",
      content: {
        "application/json": {
          schema: successEnvelope(z.object({ message: z.string(), resendAfterSeconds: z.number().int() })),
        },
      },
    },
    ...errorResponses,
    409: conflictResponse,
    503: serviceUnavailableResponse,
  },
});

app.openapi(sendAccountPhoneCodeRoute, async (c) => {
  setPrivateNoStoreHeaders(c);
  const { session } = await requireCustomerSession(c);
  if (!session.customerId) throw new UnauthorizedError("Customer profile is incomplete. Please log in again.");
  const db = c.get("db");
  const env = c.env as unknown as Record<string, unknown>;
  const result = await sendAccountPhoneCode(db, {
    accountId: session.customerId,
    ip: getTrustedClientIp(c),
    emailEnv: env,
    encryptionKey: getCredentialEncryptionKey(env),
    credentialEncryptionKey: getCredentialEncryptionKey(env),
  });
  try {
    await c.env.JOBS_QUEUE.send(result.queuePayload);
  } catch (error) {
    await deleteCustomerAuthOtpChallenge(db, { otpKey: result.otpStorageKey, deliveryKey: result.deliveryKey }).catch(() => undefined);
    console.error("[CustomerAuth] Failed to enqueue phone code:", error instanceof Error ? error.name : typeof error);
    throw new ServiceUnavailableError("We couldn't send the code. Please try again.");
  }
  return ok(c, { message: result.message, resendAfterSeconds: result.resendAfterSeconds });
});

const verifyAccountPhoneCodeRoute = createRoute({
  method: "post",
  path: "/phone/verify",
  tags: ["Customer Auth"],
  summary: "Prove the signed-in account's own phone and add orders placed with it",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({ code: z.string().trim().min(4).max(12) }).strict(),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Phone verified",
      content: {
        "application/json": {
          schema: successEnvelope(z.object({ movedOrders: z.number().int(), message: z.string() })),
        },
      },
    },
    ...errorResponses,
    409: conflictResponse,
  },
});

app.openapi(verifyAccountPhoneCodeRoute, async (c) => {
  setPrivateNoStoreHeaders(c);
  const { session } = await requireCustomerSession(c);
  if (!session.customerId) throw new UnauthorizedError("Customer profile is incomplete. Please log in again.");
  const env = c.env as unknown as Record<string, unknown>;
  const { movedOrders } = await verifyAccountPhoneCode(c.get("db"), {
    accountId: session.customerId,
    code: c.req.valid("json").code,
    encryptionKey: getCredentialEncryptionKey(env),
    credentialEncryptionKey: getCredentialEncryptionKey(env),
  });
  const added = movedOrders === 0 ? "" : movedOrders === 1 ? " 1 order was added to your account." : ` ${movedOrders} orders were added to your account.`;
  return ok(c, { movedOrders, message: `Your phone number is verified.${added}` });
});

const customerPaymentRecoverySchema = z.object({
  eligible: z.boolean(),
  gateway: z.string().nullable(),
  paymentType: z.enum(["full", "deposit", "balance"]).nullable(),
  amountDue: z.number(),
  label: z.string().nullable(),
  reason: z.string().nullable(),
  blockType: z.enum(["validation", "unavailable"]).optional(),
  requiresCardForm: z.boolean(),
  hostedRedirect: z.boolean(),
});

const claimCustomerOrderReceiptRoute = createRoute({
  method: "post",
  path: "/orders/{id}/claim-receipt",
  tags: ["Customer Auth"],
  summary: "Save a receipt-proven guest order to the authenticated customer account",
  request: {
    params: z.object({ id: z.string().trim().min(1).max(128) }),
    headers: z.object({
      "x-receipt-token": z.string().optional(),
    }),
    body: {
      content: {
        "application/json": {
          schema: z.object({}).strict(),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Order saved to the authenticated customer account",
      content: {
        "application/json": {
          schema: successEnvelope(z.object({
            orderId: z.string(),
            alreadyClaimed: z.boolean(),
          })),
        },
      },
    },
    ...errorResponses,
    409: conflictResponse,
  },
});

app.openapi(claimCustomerOrderReceiptRoute, async (c) => {
  setPrivateNoStoreHeaders(c);
  const { session } = await requireCustomerSession(c);
  if (!session.customerId) {
    throw new UnauthorizedError("Customer profile is incomplete. Please log in again.");
  }

  const orderId = c.req.valid("param").id;
  const receiptToken = c.req.valid("header")["x-receipt-token"];
  const db = c.get("db");
  await validateReceiptToken(c.env.CACHE, orderId, receiptToken, db);
  const result = await claimGuestOrderToAccount(db, {
    orderId,
    customerId: session.customerId,
    customerEmail: session.email,
    customerPhone: session.phone,
  });

  return ok(c, {
    orderId: result.orderId,
    alreadyClaimed: result.alreadyClaimed,
  });
});

const customerRefundAttemptSchema = z.object({
  id: z.string(),
  orderId: z.string(),
  amount: z.number(),
  currency: z.string(),
  gateway: z.string(),
  status: z.string(),
  providerStatus: z.string().nullable(),
  active: z.boolean(),
  severity: z.enum(["info", "success", "warning", "danger"]),
  label: z.string(),
  message: z.string(),
  createdAt: nullableTimestampSchema,
  updatedAt: nullableTimestampSchema,
  nextProbeAt: nullableTimestampSchema,
  lastProbeAt: nullableTimestampSchema,
  refundedAt: nullableTimestampSchema,
  failedAt: nullableTimestampSchema,
});

const customerActiveRefundOperationSchema = z.object({
  active: z.literal(true),
  status: z.string(),
  severity: z.enum(["info", "success", "warning", "danger"]),
  label: z.string(),
  message: z.string(),
  amount: z.number(),
  currency: z.string(),
  gateway: z.string(),
  attemptCount: z.number(),
  nextProbeAt: nullableTimestampSchema,
  lastProbeAt: nullableTimestampSchema,
  providerStatus: z.string().nullable(),
});

const customerOrderSupportRequestTypeSchema = z.enum(CUSTOMER_ORDER_SUPPORT_REQUEST_TYPES);

const customerOrderSupportRequestSchema = z.object({
  id: z.string(),
  orderId: z.string(),
  customerId: z.string().nullable(),
  type: customerOrderSupportRequestTypeSchema,
  status: z.string(),
  active: z.boolean(),
  severity: z.enum(["info", "success", "warning", "danger"]),
  label: z.string(),
  actionLabel: z.string(),
  reason: z.string(),
  message: z.string().nullable(),
  submittedAt: nullableTimestampSchema,
  resolvedAt: nullableTimestampSchema,
  createdAt: nullableTimestampSchema,
  updatedAt: nullableTimestampSchema,
});

const customerOrderSupportRequestActionSchema = z.object({
  type: customerOrderSupportRequestTypeSchema,
  label: z.string(),
  description: z.string(),
  eligible: z.boolean(),
  disabledReason: z.string().nullable(),
});

const customerOrderDetailSchema = z.object({
  order: z.object({
    id: z.string(),
    orderNumber: z.number().int().nullable(),
    invoiceNumber: z.number().nullable(),
    status: z.string(),
    totalAmount: z.number(),
    paidAmount: z.number(),
    balanceDue: z.number(),
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
    paymentStatus: z.string(),
    paymentMethod: z.string(),
    fulfillmentStatus: z.string(),
    expectedDelivery: z.string().nullable(),
    shippingAddress: z.string(),
    city: z.string(),
    zone: z.string(),
    area: z.string().nullable(),
    cityName: z.string().nullable(),
    zoneName: z.string().nullable(),
    areaName: z.string().nullable(),
    notes: z.string().nullable(),
    statusLabel: z.string(),
    customerName: z.string(),
    customerPhone: z.string(),
    createdAt: nullableTimestampSchema,
    updatedAt: nullableTimestampSchema,
  }).passthrough(),
  items: z.array(z.object({
    id: z.string(),
    productId: z.string(),
    variantId: z.string().nullable(),
    quantity: z.number(),
    price: z.number(),
    productName: z.string().nullable(),
    productSlug: z.string().nullable(),
    productImage: z.string().nullable(),
    variantLabel: z.string().nullable(),
    unitPrice: z.number(),
    lineTotal: z.number(),
    unitPriceMinor: z.number().int().nullable(),
    lineSubtotalMinor: z.number().int().nullable(),
    discountAmountMinor: z.number().int().nullable(),
    taxableAmountMinor: z.number().int().nullable(),
    taxAmountMinor: z.number().int(),
    fulfillmentStatus: z.string(),
    createdAt: nullableTimestampSchema,
  }).passthrough()),
  shipments: z.array(z.object({
    id: z.string(),
    providerType: z.string(),
    providerName: z.string().nullable(),
    status: z.string(),
    rawStatus: z.string().nullable(),
    trackingId: z.string().nullable(),
    trackingUrl: z.string().nullable(),
    courierName: z.string().nullable(),
    note: z.string().nullable(),
    shipmentAmount: z.number().nullable(),
    isFinalShipment: z.boolean(),
    statusLabel: z.string(),
    lastChecked: nullableTimestampSchema,
    updatedAt: nullableTimestampSchema,
    createdAt: nullableTimestampSchema,
  }).passthrough()),
  payments: z.array(z.object({
    id: z.string(),
    amount: z.number(),
    currency: z.string(),
    paymentMethod: z.string(),
    paymentType: z.string(),
    status: z.string(),
    codReceiptUrl: z.string().nullable(),
    createdAt: nullableTimestampSchema,
    updatedAt: nullableTimestampSchema,
  }).passthrough()),
  refundAttempts: z.array(customerRefundAttemptSchema),
  activeRefundOperation: customerActiveRefundOperationSchema.nullable(),
  supportRequests: z.array(customerOrderSupportRequestSchema),
  supportRequestActions: z.array(customerOrderSupportRequestActionSchema),
  supportRequestIntro: z.string(),
  paymentPlan: z.object({
    totalAmount: z.number(),
    depositAmount: z.number(),
    balanceDue: z.number(),
    balanceDueDate: z.string().nullable(),
    status: z.string(),
    depositPaidAt: nullableTimestampSchema,
    balancePaidAt: nullableTimestampSchema,
    createdAt: nullableTimestampSchema,
    updatedAt: nullableTimestampSchema,
  }).passthrough().nullable(),
  cod: z.object({
    codStatus: z.string(),
    deliveryAttempts: z.number(),
    failureReason: z.string().nullable(),
    collectedAmount: z.number().nullable(),
    receiptUrl: z.string().nullable(),
    lastAttemptAt: nullableTimestampSchema,
    collectedAt: nullableTimestampSchema,
    updatedAt: nullableTimestampSchema,
  }).passthrough().nullable(),
  progress: buyerOrderProgressSchema,
  timeline: buyerOrderTimelineSchema,
  /** Each discount the order used: `amount` off the items, `shippingAmount` off delivery. */
  discounts: z.array(orderDiscountLineSchema),
  paymentRecovery: customerPaymentRecoverySchema,
});

const getCustomerOrderDetailRoute = createRoute({
  method: "get",
  path: "/orders/{id}",
  tags: ["Customer Auth"],
  summary: "Get one authenticated customer order with timeline",
  request: {
    params: z.object({
      id: z.string(),
    }),
  },
  responses: {
    200: {
      description: "Customer order detail",
      content: {
        "application/json": {
          schema: successEnvelope(customerOrderDetailSchema),
        },
      },
    },
    ...errorResponses,
  },
});

app.openapi(getCustomerOrderDetailRoute, async (c) => {
  setPrivateNoStoreHeaders(c);

  const { session } = await requireCustomerSession(c);
  if (!session.customerId) {
    throw new UnauthorizedError("Customer profile is incomplete. Please log in again.");
  }

  const orderId = c.req.valid("param").id;
  const order = await getCustomerOwnedOrderForDetail(c.get("db"), session.customerId, orderId);
  const [detail, discountLines, paymentRecovery] = await Promise.all([
    getCustomerOrderDetailForOrder(c.get("db"), order),
    listOrderDiscountLines(c.get("db"), orderId),
    resolveCustomerPaymentSessionRecovery(c, {
      orderId,
      expectedCustomerId: session.customerId,
      order: getCustomerPaymentSessionOrderForDetail(order),
    }),
  ]);

  return ok(c, {
    ...detail,
    discounts: presentOrderDiscountLines(discountLines, order.currencyDecimalPlaces),
    paymentRecovery,
  });
});

const createCustomerOrderSupportRequestRoute = createRoute({
  method: "post",
  path: "/orders/{id}/support-requests",
  tags: ["Customer Auth"],
  summary: "Create an authenticated customer support request for an owned order",
  request: {
    params: z.object({
      id: z.string(),
    }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            type: customerOrderSupportRequestTypeSchema,
            reason: z.string().trim().min(3).max(500),
            message: z.string().trim().max(1000).nullable().optional(),
          }).strict(),
        },
      },
    },
  },
  responses: {
    201: {
      description: "Customer support request created",
      content: {
        "application/json": {
          schema: successEnvelope(z.object({
            request: customerOrderSupportRequestSchema,
            supportRequests: z.array(customerOrderSupportRequestSchema),
            supportRequestActions: z.array(customerOrderSupportRequestActionSchema),
            supportRequestIntro: z.string(),
          })),
        },
      },
    },
    ...errorResponses,
    409: conflictResponse,
  },
});

app.openapi(createCustomerOrderSupportRequestRoute, async (c) => {
  setPrivateNoStoreHeaders(c);

  const { session } = await requireCustomerSession(c);
  if (!session.customerId) {
    throw new UnauthorizedError("Customer profile is incomplete. Please log in again.");
  }

  const db = c.get("db");
  const orderId = c.req.valid("param").id;
  const body = c.req.valid("json");
  const result = await createCustomerOrderSupportRequest(db, session.customerId, orderId, body);
  await enqueueOrderSupportRequestNotificationForOrder({
    db,
    queue: c.env.JOBS_QUEUE,
    orderId,
    requestId: result.request.id,
    notificationType: "support_request_submitted",
    source: "customer-support-request",
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

/** Card gateways return `stripe` (browser confirmation); hosted gateways return `hosted` (redirect). */
const customerPaymentSessionSchema = z.object({
  gateway: z.string(),
  paymentType: z.enum(["full", "deposit", "balance"]),
  amount: z.number(),
  currency: z.string(),
  stripe: z.object({
    clientSecret: z.string().optional(),
    paymentIntentId: z.string().optional(),
    publishableKey: z.string(),
    amount: z.number(),
    currency: z.string(),
  }).optional(),
  hosted: z.object({
    gatewayUrl: z.string().optional(),
    sessionKey: z.string().optional(),
  }).optional(),
});

const createCustomerOrderPaymentSessionRoute = createRoute({
  method: "post",
  path: "/orders/{id}/payment-session",
  tags: ["Customer Auth"],
  summary: "Create an authenticated customer payment session for an owned order",
  request: {
    params: z.object({
      id: z.string(),
    }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            gateway: z.string().max(64).optional(),
            replaceExistingAttempt: z.boolean().optional(),
          }).strict(),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Customer payment session created",
      content: {
        "application/json": {
          schema: successEnvelope(customerPaymentSessionSchema),
        },
      },
    },
    202: paymentSessionProcessingResponse,
    ...errorResponses,
    409: conflictResponse,
    503: serviceUnavailableResponse,
  },
});

app.openapi(createCustomerOrderPaymentSessionRoute, async (c) => {
  setPrivateNoStoreHeaders(c);

  const { session } = await requireCustomerSession(c);
  if (!session.customerId) {
    throw new UnauthorizedError("Customer profile is incomplete. Please log in again.");
  }

  const orderId = c.req.valid("param").id;
  const body = c.req.valid("json");
  const result = await createCustomerAccountPaymentSession(c, {
    orderId,
    customerId: session.customerId,
    ...(body.gateway ? { gateway: body.gateway } : {}),
    ...(body.replaceExistingAttempt !== undefined
      ? { replaceExistingAttempt: body.replaceExistingAttempt }
      : {}),
  });
  if (isPaymentSessionProcessingResult(result)) {
    return acceptedPaymentSessionProcessing(c, result);
  }

  return ok(c, result);
});

export { app as customerAuthRoutes };
