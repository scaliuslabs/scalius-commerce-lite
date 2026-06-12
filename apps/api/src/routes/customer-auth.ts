// src/server/routes/customer-auth.ts
// Customer-facing authentication via email OTP.
//
// Endpoints (mounted at /api/v1/customer-auth):
//   POST /send-otp   — generate & email a 6-digit OTP (5-min TTL in KV)
//   POST /verify-otp — verify OTP, create 30-day session in KV, set cookie
//   GET  /me         — return session customer info (reads cookie)
//   POST /logout     — delete session from KV, clear cookie
//   PUT  /profile    — update customer profile
//   GET  /orders     — return orders for authenticated customer
//
// Session storage: Cloudflare KV (binding: CACHE), prefix "cust_session:"
// OTP storage:     Cloudflare KV (binding: CACHE), prefix "cust_otp:"
// Cookie name:     "cs_tok" (httpOnly, SameSite=Strict, Secure)

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  sendOtp,
  verifyOtp,
  getCustomerBySession,
  deleteCustomerSession,
  updateCustomerProfile,
  getSessionCookie,
  getCookieConfig,
  buildSetCookieHeader,
  COOKIE_NAME,
  SESSION_TTL_SECONDS
} from "@scalius/core/modules/customers/customer-auth.service";
import { isValidPhoneNumber } from "@scalius/shared/customer-utils";
import { getCustomerOrders } from "@scalius/core/modules/customers/customers.service";
import { UnauthorizedError, ValidationError, ForbiddenError, RateLimitError } from "../utils/api-error";
import { successEnvelope, messageResponse, errorResponses } from "../schemas/responses";
import { nullableTimestampSchema } from "../schemas/timestamps";
import { ok } from "../utils/api-response";

const app = new OpenAPIHono<{ Bindings: Env }>();

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
            identifier: z.string().openapi({ description: "Email or phone number" }),
            name: z.string().optional()
          }).superRefine((data, ctx) => {
            if (data.method === "phone" && !isValidPhoneNumber(data.identifier)) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: "Invalid phone number",
                path: ["identifier"]
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

  const db = c.get("db");
  const kv = c.env.CACHE;
  const ip = c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for") || "unknown";

  const result = await sendOtp(db, kv, { method, identifier: identifier!, name, ip });

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
    await c.env.AUTH_OTP_QUEUE.send(result.queuePayload);
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
            if (data.phone && !isValidPhoneNumber(data.phone)) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: "Invalid phone number",
                path: ["phone"]
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
            customer: z.object({}).passthrough().optional(),
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
    identifier: identifier!,
    code: code!,
    name,
    phone,
    email
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
            customer: z.object({
              email: z.string(),
              name: z.string(),
              phone: z.string().nullable(),
              customerId: z.string().nullable(),
            }).optional(),
          })),
        },
      },
    },
    ...errorResponses,
  },
});

app.openapi(getMeRoute, async (c) => {
  const cookieHeader = c.req.header("Cookie") || null;
  const token = getSessionCookie(cookieHeader);

  if (!token) {
    return ok(c, { authenticated: false });
  }

  const kv = c.env.CACHE;
  const session = await getCustomerBySession(kv, token);

  if (!session) {
    return ok(c, { authenticated: false });
  }

  return ok(c, {
    authenticated: true,
    customer: {
      email: session.email,
      name: session.name,
      phone: session.phone,
      customerId: session.customerId
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

  // Delete KV session (best-effort)
  try {
    const cookieHeader = c.req.header("Cookie") || null;
    const token = getSessionCookie(cookieHeader);
    if (token) {
      await deleteCustomerSession(c.env.CACHE, token);
    }
  } catch (error: unknown) {
    console.error("[CustomerAuth] KV session delete failed:", error);
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
            cityName: z.string().optional(),
            zoneName: z.string().optional()
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
            customer: z.object({
              email: z.string(),
              name: z.string(),
              phone: z.string().optional(),
              address: z.string().optional(),
              cityName: z.string().optional(),
              zoneName: z.string().optional(),
            }),
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

  const kv = c.env.CACHE;
  const session = await getCustomerBySession(kv, token);

  if (!session) {
    throw new UnauthorizedError("Session expired. Please log in again.");
  }

  const body = c.req.valid("json");

  // Sanitize inputs
  const updates: Record<string, string | undefined> = {};
  if (body.name?.trim()) updates.name = body.name.trim();
  if (body.address?.trim()) updates.address = body.address.trim();
  if (body.city?.trim()) updates.city = body.city.trim();
  if (body.zone?.trim()) updates.zone = body.zone.trim();
  if (body.cityName?.trim()) updates.cityName = body.cityName.trim();
  if (body.zoneName?.trim()) updates.zoneName = body.zoneName.trim();

  const db = c.get("db");
  const result = await updateCustomerProfile(db, kv, session, token, updates);

  return ok(c, {
    customer: {
      email: result.session.email,
      name: result.session.name,
      phone: result.session.phone,
      address: updates.address,
      cityName: updates.cityName,
      zoneName: updates.zoneName
    }
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
            orders: z.array(z.object({ id: z.string(), status: z.string(), totalAmount: z.number(), createdAt: nullableTimestampSchema }).passthrough()),
            customer: z.object({ id: z.string(), name: z.string(), phone: z.string() }).passthrough(),
          })),
        },
      },
    },
    ...errorResponses,
  },
});

app.openapi(getCustomerOrdersRoute, (async (c: any) => {
  const cookieHeader = c.req.header("Cookie") || null;
  const token = getSessionCookie(cookieHeader);

  if (!token) {
    throw new UnauthorizedError("Authentication required");
  }

  const kv = c.env.CACHE;
  const session = await getCustomerBySession(kv, token);

  if (!session) {
    throw new UnauthorizedError("Session expired. Please log in again.");
  }

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
}) as any);

export { app as customerAuthRoutes };
