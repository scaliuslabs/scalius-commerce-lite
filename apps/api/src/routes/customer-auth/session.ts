// Customer sign-in by OTP, the current session, and sign-out.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  sendOtp,
  verifyOtp,
  getCustomerBySession,
  deleteCustomerSession,
  getSessionCookie,
  getCookieConfig,
  buildSetCookieHeader,
  deleteCustomerAuthOtpChallenge,
  COOKIE_NAME,
  SESSION_TTL_SECONDS,
} from "@scalius/core/modules/customers";
import { CUSTOMER_AUTH_OTP_CHANNELS } from "@scalius/shared/customer-auth-policy";
import { ServiceUnavailableError } from "../../utils/api-error";
import {
  errorResponses,
  messageResponse,
  serviceUnavailableResponse,
  successEnvelope,
} from "../../schemas/responses";
import { ok } from "../../utils/api-response";
import { getCredentialEncryptionKey, getCustomerSessionHashKey } from "../../utils/encryption-key";
import { getTrustedClientIp } from "../../utils/client-ip";
import { customerAuthProfileSchema, setPrivateNoStoreHeaders } from "./shared";

const app = new OpenAPIHono<{ Bindings: Env }>();

const customerAuthChannelSchema = z.enum(CUSTOMER_AUTH_OTP_CHANNELS);

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

export { app as customerSessionRoutes };
