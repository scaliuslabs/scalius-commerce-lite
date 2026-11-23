// Adding and verifying a phone number on the customer account.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  SESSION_TTL_SECONDS,
  buildSetCookieHeader,
  getCookieConfig,
  sendAccountPhoneCode,
  verifyAccountPhoneCode,
} from "@scalius/core/modules/customers";
import { UnauthorizedError } from "../../utils/api-error";
import {
  conflictResponse,
  errorResponses,
  serviceUnavailableResponse,
  successEnvelope,
} from "../../schemas/responses";
import { ok } from "../../utils/api-response";
import { getCredentialEncryptionKey, getCustomerSessionHashKey } from "../../utils/encryption-key";
import { requestAppProviders } from "../../plugins/providers/app-providers";
import { getTrustedClientIp } from "../../utils/client-ip";
import { setPrivateNoStoreHeaders, requireCustomerSession } from "./shared";
import { sendAuthOtp } from "../../background/otp-sender";

const app = new OpenAPIHono<{ Bindings: Env }>();

// ─── The account's own phone, proven by code ─────────────────────────────────

const sendAccountPhoneCodeRoute = createRoute({
  method: "post",
  path: "/phone/send-code",
  tags: ["Customer Auth"],
  summary: "Send a code to the signed-in account's own phone, or to a new number its phone moves to",
  request: {
    body: {
      required: false,
      content: {
        "application/json": {
          schema: z.object({
            phone: z.string().trim().max(32).optional().openapi({ description: "The number to make the account's sign-in phone. Absent: the account's own unproven phone. Either way two codes go out, both for this one change: one to how the account signs in now (its proven email, else its proven phone; `confirmWith`) and one to the number." }),
          }).strict(),
        },
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
            confirmWith: z.enum(["phone", "email"]).openapi({ description: "Where the confirming code went: the account's proven email, else its proven phone. Send that code back as `currentCode`." }),
          })),
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
  // The body is optional: without one the code goes to the account's own phone.
  const phone = (c.req.valid("json") as { phone?: string } | undefined)?.phone;
  const result = await sendAccountPhoneCode(db, {
    accountId: session.customerId,
    phone,
    ip: getTrustedClientIp(c),
    emailEnv: env,
    encryptionKey: getCredentialEncryptionKey(env),
    credentialEncryptionKey: getCredentialEncryptionKey(env),
    appProviders: requestAppProviders(c),
  });
  for (const delivery of result.otpDeliveries) await sendAuthOtp(c, c.get("db"), delivery);
  return ok(c, { message: result.message, resendAfterSeconds: result.resendAfterSeconds, confirmWith: result.confirmWith });
});

const verifyAccountPhoneCodeRoute = createRoute({
  method: "post",
  path: "/phone/verify",
  tags: ["Customer Auth"],
  summary: "Make a proven number the account's sign-in phone (two codes); signs out every session and sets a new one",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            code: z.string().trim().min(4).max(12),
            phone: z.string().trim().max(32).optional().openapi({ description: "The number the codes were sent for (absent: the account's own phone); `code` is the one sent to it." }),
            currentCode: z.string().trim().min(4).max(12).optional().openapi({ description: "The code sent to how the account signs in now (required)." }),
          }).strict(),
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
  const { code, phone, currentCode } = c.req.valid("json");
  const db = c.get("db");
  const proof = await verifyAccountPhoneCode(db, {
    accountId: session.customerId,
    code,
    phone,
    currentCode,
    sessionHashKey: getCustomerSessionHashKey(env),
    encryptionKey: getCredentialEncryptionKey(env),
    credentialEncryptionKey: getCredentialEncryptionKey(env),
  });
  // Every session of the account ended, this one too: the new one replaces its cookie.
  const { sameSite, domainAttr } = getCookieConfig(c.env.STOREFRONT_URL as string | undefined, c.env.CUSTOMER_AUTH_COOKIE_DOMAIN as string | undefined);
  c.header("Set-Cookie", buildSetCookieHeader(proof.session.token, SESSION_TTL_SECONDS, domainAttr, sameSite), { append: true });
  if (proof.notice) await sendAuthOtp(c, db, proof.notice);
  const { movedOrders } = proof;
  const added = movedOrders === 0 ? "" : movedOrders === 1 ? " 1 order was added to your account." : ` ${movedOrders} orders were added to your account.`;
  return ok(c, { movedOrders, message: `Your phone number is verified. You were signed out on other devices.${added}` });
});

export { app as customerPhoneRoutes };
