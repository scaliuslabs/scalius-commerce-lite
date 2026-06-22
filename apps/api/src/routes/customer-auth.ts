// src/server/routes/customer-auth.ts
// Customer-facing authentication via email OTP.
//
// Endpoints (mounted at /api/v1/customer-auth):
//   POST /send-otp   — generate & deliver a 6-digit OTP (5-min D1 challenge)
//   POST /verify-otp — atomically verify OTP, create 30-day D1 session, set cookie
//   GET  /me         — return session customer info (reads cookie)
//   POST /logout     — revoke D1 session, clear cookie
//   PUT  /profile    — update customer profile
//   GET  /orders     — return orders for authenticated customer
//
// Session storage: D1 customer_sessions table keyed by HMAC token hash.
// OTP challenges:  D1 table "customer_auth_otp_challenges", key prefix "cust_otp:"
// Cookie name:     "cs_tok" (httpOnly, SameSite=Strict, Secure)

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
  COOKIE_NAME,
  SESSION_TTL_SECONDS
} from "@scalius/core/modules/customers/customer-auth.service";
import { isValidPhoneNumber } from "@scalius/shared/customer-utils";
import { getCustomerOrderDetail, getCustomerOrders } from "@scalius/core/modules/customers/customers.service";
import { CUSTOMER_AUTH_OTP_CHANNELS } from "@scalius/shared/customer-auth-policy";
import { UnauthorizedError, ValidationError, ForbiddenError, RateLimitError, ServiceUnavailableError } from "../utils/api-error";
import {
  conflictResponse,
  errorResponses,
  messageResponse,
  serviceUnavailableResponse,
  successEnvelope,
} from "../schemas/responses";
import { nullableTimestampSchema } from "../schemas/timestamps";
import { ok } from "../utils/api-response";
import { getCredentialEncryptionKey, getCustomerSessionHashKey, getEncryptionKey } from "../utils/encryption-key";
import {
  createPolarPaymentSession,
  createSSLCommerzPaymentSession,
  createStripePaymentSession,
  resolveCustomerPaymentSessionRecovery,
} from "./payment/payment-session-create";

const app = new OpenAPIHono<{ Bindings: Env }>();
const customerAuthIntentSchema = z.enum(["sign_in", "sign_up"]);
const customerAuthChannelSchema = z.enum(CUSTOMER_AUTH_OTP_CHANNELS);
const customerAuthProfileSchema = z.object({
  identifier: z.string().optional(),
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
  needsProfileCompletion: z.boolean(),
});

function setPrivateNoStoreHeaders(c: Context) {
  c.header("Cache-Control", "private, no-cache, no-store, must-revalidate");
  c.header("Pragma", "no-cache");
  c.header("Expires", "0");
}

function getCustomerAuthClientIp(c: Context<{ Bindings: Env }>): string {
  const cloudflareIp = normalizeSingleIp(c.req.header("cf-connecting-ip"));
  if (cloudflareIp) return cloudflareIp;

  const runtimeOrigins = [
    c.env.PUBLIC_API_BASE_URL,
    c.env.BETTER_AUTH_URL,
    c.env.STOREFRONT_URL,
    new URL(c.req.url).origin,
  ];
  if (runtimeOrigins.some(isLoopbackOrigin)) {
    return firstForwardedIp(c.req.header("x-forwarded-for")) ?? "unknown";
  }

  return "unknown";
}

function firstForwardedIp(value: string | undefined): string | null {
  if (!value) return null;
  for (const part of value.split(",")) {
    const ip = normalizeSingleIp(part);
    if (ip) return ip;
  }
  return null;
}

function normalizeSingleIp(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.includes(",")) return null;
  if (isValidIpv4(trimmed) || isValidIpv6(trimmed)) return trimmed;
  return null;
}

function isValidIpv4(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false;
    const parsed = Number.parseInt(part, 10);
    return parsed >= 0 && parsed <= 255 && String(parsed) === part;
  });
}

function isValidIpv6(value: string): boolean {
  if (!value.includes(":")) return false;
  try {
    new URL(`http://[${value.replace(/^\[|\]$/g, "")}]`);
    return true;
  } catch {
    return false;
  }
}

function isLoopbackOrigin(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const hostname = new URL(value).hostname;
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  } catch {
    return false;
  }
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

const sendOtpRoute = createRoute({
  method: "post",
  path: "/send-otp",
  tags: ["Customer Auth"],
  summary: "Send OTP verification code",
  request: {
    body: {
      content: {
        "application/json": {
	          schema: z.object({
	            method: z.enum(["email", "phone"]).optional().default("email"),
	            channel: customerAuthChannelSchema.optional(),
	            intent: customerAuthIntentSchema.optional().default("sign_in"),
	            identifier: z.string().openapi({ description: "Email or phone number" }),
	            name: z.string().optional(),
	            phone: z.string().optional(),
	            email: z.string().optional(),
	          }).superRefine((data, ctx) => {
	            if (data.method === "phone" && !isValidPhoneNumber(data.identifier)) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: "Invalid phone number",
                path: ["identifier"]
	              });
	            }
            if (data.method === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.identifier.trim())) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: "Invalid email address",
                path: ["identifier"]
              });
            }
	            if (data.phone && !isValidPhoneNumber(data.phone)) {
	              ctx.addIssue({
	                code: z.ZodIssueCode.custom,
	                message: "Invalid phone number",
	                path: ["phone"]
	              });
	            }
	            if (data.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email.trim())) {
	              ctx.addIssue({
	                code: z.ZodIssueCode.custom,
	                message: "Invalid email address",
	                path: ["email"]
	              });
	            }
	          })
        }
      }
    }
  },
  responses: {
    200: {
      description: "OTP sent successfully",
      content: { "application/json": { schema: successEnvelope(z.object({ message: z.string().optional() })) } },
    },
    ...errorResponses,
  },
});

app.openapi(sendOtpRoute, async (c) => {
  const body = c.req.valid("json");
	  const method = body.method || "email";
	  const identifier = body.identifier?.trim().toLowerCase();
	  const name = body.name?.trim() || "Customer";
	  const phone = body.phone?.trim();
	  const email = body.email?.trim().toLowerCase();

  const db = c.get("db");
  const kv = c.env.CACHE;
  const ip = getCustomerAuthClientIp(c);

  const result = await sendOtp(db, kv, {
	    method,
	    channel: body.channel,
	    intent: body.intent,
	    identifier: identifier!,
	    name,
	    ip,
    phone,
    email,
    emailEnv: c.env as unknown as Record<string, unknown>,
    encryptionKey: getEncryptionKey(c.env as unknown as Record<string, unknown>),
    credentialEncryptionKey: getCredentialEncryptionKey(c.env as unknown as Record<string, unknown>),
    migrationEncryptionKey: getCredentialEncryptionKey(c.env as unknown as Record<string, unknown>),
  });

  if (!result.success) {
    const status = result.httpStatus || 400;
    if (status === 429) {
      throw new RateLimitError(result.error || "Too many requests");
    }
    if (status === 403) {
      throw new ForbiddenError(result.error || "Method disabled");
    }
    throw new ValidationError(result.error || "Invalid input");
  }

  // Dispatch OTP delivery to queue
  if (result.queuePayload) {
    try {
      await c.env.AUTH_OTP_QUEUE.send(result.queuePayload);
    } catch (error) {
      if (result.otpStorageKey) {
        if (result.deliveryKey) {
          await deleteCustomerAuthOtpChallenge(db, {
            otpKey: result.otpStorageKey,
            deliveryKey: result.deliveryKey,
          }).catch((deleteError: unknown) => {
            console.error("[CustomerAuth] Failed to clear OTP challenge after queue handoff failure:", deleteError);
          });
        }
      }
      console.error("[CustomerAuth] Failed to enqueue OTP delivery:", error);
      throw new ServiceUnavailableError("Could not queue verification code delivery. Please try again.");
    }
  }

  return ok(c, { message: result.message });
});

// ─── POST /verify-otp ────────────────────────────────────────────────────────

const verifyOtpRoute = createRoute({
  method: "post",
  path: "/verify-otp",
  tags: ["Customer Auth"],
  summary: "Verify OTP and create session",
  request: {
    body: {
      content: {
        "application/json": {
	          schema: z.object({
	            method: z.enum(["email", "phone"]).optional().default("email"),
	            channel: customerAuthChannelSchema.optional(),
	            intent: customerAuthIntentSchema.optional().default("sign_in"),
	            identifier: z.string().openapi({ description: "Email or phone number" }),
            code: z.string().openapi({ description: "6-digit OTP code" }),
            name: z.string().optional(),
            phone: z.string().optional(),
            email: z.string().optional()
          }).superRefine((data, ctx) => {
            if (data.method === "phone" && !isValidPhoneNumber(data.identifier)) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: "Invalid phone number",
                path: ["identifier"]
              });
            }
            if (data.method === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.identifier.trim())) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: "Invalid email address",
                path: ["identifier"]
              });
            }
            if (data.phone && !isValidPhoneNumber(data.phone)) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: "Invalid phone number",
                path: ["phone"]
              });
            }
            if (data.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email.trim())) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: "Invalid email address",
                path: ["email"]
              });
            }
          })
        }
      }
    }
  },
  responses: {
    200: {
      description: "OTP verified, session created",
      content: {
        "application/json": {
          schema: successEnvelope(z.object({
            customer: customerAuthProfileSchema.optional(),
            isNewUser: z.boolean().optional(),
          })),
        },
      },
    },
    ...errorResponses,
  },
});

app.openapi(verifyOtpRoute, async (c) => {
  const body = c.req.valid("json");
  const method = body.method || "email";
  const identifier = body.identifier?.trim().toLowerCase();
  const code = body.code?.trim();
	  const name = body.name?.trim() || "Customer";
  const phone = body.phone?.trim();
  const email = body.email?.trim().toLowerCase();

  const db = c.get("db");
  const kv = c.env.CACHE;

  const result = await verifyOtp(db, kv, {
	    method,
	    channel: body.channel,
	    intent: body.intent,
	    identifier: identifier!,
    code: code!,
    name,
    phone,
    email,
    encryptionKey: getEncryptionKey(c.env as unknown as Record<string, unknown>),
    sessionHashKey: getCustomerSessionHashKey(c.env as unknown as Record<string, unknown>),
  });

  if (!result.success) {
    const status = result.httpStatus || 400;
    if (status === 429) {
      throw new RateLimitError(result.error || "Too many attempts");
    }
    throw new ValidationError(
      result.error || "Invalid code",
      result.attemptsLeft !== undefined ? { attemptsLeft: result.attemptsLeft } : undefined
    );
  }

  // Set cookies
  const { sameSite, domainAttr } = getCookieConfig(c.env.STOREFRONT_URL as string | undefined);
  c.header("Set-Cookie", buildSetCookieHeader(result.session!.token, SESSION_TTL_SECONDS, domainAttr, sameSite));
  c.header("Set-Cookie", `cs_auth=1; Max-Age=${SESSION_TTL_SECONDS}; Path=/${domainAttr}; SameSite=${sameSite}; Secure`, { append: true });

  return ok(c, {
    customer: result.customer,
    isNewUser: result.isNewUser
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

  return ok(c, {
    authenticated: true,
    customer: {
      email: session.email,
      name: session.name,
      phone: session.phone,
      customerId: session.customerId,
      address: session.address,
      city: session.city,
      zone: session.zone,
      area: session.area,
      cityName: session.cityName,
      zoneName: session.zoneName,
      areaName: session.areaName,
      profileComplete: session.profileComplete,
      needsProfileCompletion: session.needsProfileCompletion,
    }
  });
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
  const { sameSite, domainAttr } = getCookieConfig(c.env.STOREFRONT_URL as string | undefined);

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

  const body = c.req.valid("json");

  // Sanitize inputs
  const updates: Record<string, string | undefined> = {};
  if (body.name?.trim()) updates.name = body.name.trim();
  if (body.address?.trim()) updates.address = body.address.trim();
  if (body.address !== undefined && !body.address.trim()) updates.address = "";
  if (body.city !== undefined) updates.city = body.city.trim();
  if (body.zone !== undefined) updates.zone = body.zone.trim();
  if (body.area !== undefined) updates.area = body.area.trim();

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
  responses: {
    200: {
      description: "Customer orders list",
      content: {
        "application/json": {
          schema: successEnvelope(z.object({
            orders: z.array(z.object({
              id: z.string(),
              status: z.string(),
              totalAmount: z.number(),
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
                lastChecked: nullableTimestampSchema,
                updatedAt: nullableTimestampSchema,
                createdAt: nullableTimestampSchema,
              }).nullable().optional(),
            }).passthrough()),
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

  // Build a fallback customer profile from session data
  const sessionProfile = {
    name: session.name || "Customer",
    email: session.email,
    phone: session.phone
  };

  // Match orders EXCLUSIVELY by customerId
  if (!session.customerId) {
    return ok(c, { orders: [], customer: sessionProfile });
  }

  const db = c.get("db");
  const result = await getCustomerOrders(db, session.customerId);

  // Merge session data into profile (DB profile wins, session fills gaps)
  const customer = result.customerProfile
    ? {
        ...result.customerProfile,
        name: result.customerProfile.name || session.name || "Customer",
        email: result.customerProfile.email || session.email,
        phone: result.customerProfile.phone || session.phone,
      }
    : sessionProfile;

  return ok(c, { orders: result.orders, customer });
});

const customerPaymentRecoverySchema = z.object({
  eligible: z.boolean(),
  gateway: z.enum(["stripe", "sslcommerz", "polar"]).nullable(),
  paymentType: z.enum(["full", "deposit", "balance"]).nullable(),
  amountDue: z.number(),
  label: z.string().nullable(),
  reason: z.string().nullable(),
  blockType: z.enum(["validation", "unavailable"]).optional(),
  requiresCardForm: z.boolean(),
  hostedRedirect: z.boolean(),
});

const customerOrderDetailSchema = z.object({
  order: z.object({
    id: z.string(),
    invoiceNumber: z.number().nullable(),
    status: z.string(),
    totalAmount: z.number(),
    paidAmount: z.number(),
    balanceDue: z.number(),
    shippingCharge: z.number(),
    discountAmount: z.number().nullable(),
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
    variantSize: z.string().nullable(),
    variantColor: z.string().nullable(),
    unitPrice: z.number(),
    lineTotal: z.number(),
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
  notifications: z.array(z.object({
    id: z.string(),
    notificationType: z.string(),
    channel: z.string(),
    status: z.string(),
    provider: z.string(),
    providerStatus: z.string().nullable(),
    acceptedAt: nullableTimestampSchema,
    deliveredAt: nullableTimestampSchema,
    failedAt: nullableTimestampSchema,
    skippedAt: nullableTimestampSchema,
    updatedAt: nullableTimestampSchema,
    createdAt: nullableTimestampSchema,
  }).passthrough()),
  timeline: z.array(z.object({
    id: z.string(),
    type: z.enum(["order", "payment", "shipment", "notification"]),
    status: z.string(),
    label: z.string(),
    happenedAt: nullableTimestampSchema,
    details: z.string().nullable().optional(),
  })),
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

  const db = c.get("db");
  const orderId = c.req.valid("param").id;
  const [detail, paymentRecovery] = await Promise.all([
    getCustomerOrderDetail(db, session.customerId, orderId),
    resolveCustomerPaymentSessionRecovery(c, {
      orderId,
      expectedCustomerId: session.customerId,
    }),
  ]);

  return ok(c, { ...detail, paymentRecovery });
});

const paymentSessionBaseSchema = z.object({
  paymentType: z.enum(["full", "deposit", "balance"]),
  amount: z.number(),
  currency: z.string(),
});

const customerPaymentSessionSchema = z.discriminatedUnion("gateway", [
  paymentSessionBaseSchema.extend({
    gateway: z.literal("stripe"),
    stripe: z.object({
      clientSecret: z.string().optional(),
      paymentIntentId: z.string().optional(),
      publishableKey: z.string(),
      amount: z.number(),
      currency: z.string(),
    }),
  }),
  paymentSessionBaseSchema.extend({
    gateway: z.literal("sslcommerz"),
    hosted: z.object({
      gatewayUrl: z.string().optional(),
      sessionKey: z.string().optional(),
    }),
  }),
  paymentSessionBaseSchema.extend({
    gateway: z.literal("polar"),
    hosted: z.object({
      gatewayUrl: z.string().optional(),
      checkoutId: z.string().optional(),
    }),
  }),
]);

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
          schema: z.object({}).strict(),
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
  const paymentRecovery = await resolveCustomerPaymentSessionRecovery(c, {
    orderId,
    expectedCustomerId: session.customerId,
  });

  if (!paymentRecovery.eligible || !paymentRecovery.gateway || !paymentRecovery.paymentType) {
    if (paymentRecovery.blockType === "unavailable") {
      throw new ServiceUnavailableError(paymentRecovery.reason || "Payment gateway is not available right now.");
    }
    throw new ValidationError(paymentRecovery.reason || "This order is not ready for customer payment recovery.");
  }

  const input = {
    orderId,
    paymentType: paymentRecovery.paymentType,
    proof: { kind: "customer_account" as const, customerId: session.customerId },
    returnTarget: { kind: "customer_account" as const },
    expectedCustomerId: session.customerId,
  };

  if (paymentRecovery.gateway === "stripe") {
    const result = await createStripePaymentSession(c, input);
    return ok(c, {
      gateway: result.gateway,
      paymentType: result.paymentType,
      amount: result.amount,
      currency: result.currency,
      stripe: result.stripe,
    });
  }

  if (paymentRecovery.gateway === "sslcommerz") {
    const result = await createSSLCommerzPaymentSession(c, input);
    return ok(c, {
      gateway: result.gateway,
      paymentType: result.paymentType,
      amount: result.amount,
      currency: result.currency,
      hosted: result.hosted,
    });
  }

  const result = await createPolarPaymentSession(c, input);
  return ok(c, {
    gateway: result.gateway,
    paymentType: result.paymentType,
    amount: result.amount,
    currency: result.currency,
    hosted: result.hosted,
  });
});

export { app as customerAuthRoutes };
