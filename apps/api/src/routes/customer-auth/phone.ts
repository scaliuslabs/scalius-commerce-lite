// Adding and verifying a phone number on the customer account.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  hashCustomerSessionToken,
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
            phone: z.string().trim().max(32).optional().openapi({ description: "A new number for the account's phone: a code goes to how the account signs in now (its proven phone, else its email) and one to the new number, both for this change only. Absent: the account's own unproven phone." }),
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
            confirmWith: z.enum(["phone", "email"]).nullable().openapi({ description: "For a change: where the code that confirms it went (send it back as `currentCode`); null for the account's own phone." }),
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
  summary: "Prove the account's phone (or the new number it moves to) and add orders placed with it",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            code: z.string().trim().min(4).max(12),
            phone: z.string().trim().max(32).optional().openapi({ description: "The new number of a change: `code` is the one sent to it." }),
            currentCode: z.string().trim().min(4).max(12).optional().openapi({ description: "For a change: the code sent to how the account signs in now." }),
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
  const { session, token } = await requireCustomerSession(c);
  if (!session.customerId) throw new UnauthorizedError("Customer profile is incomplete. Please log in again.");
  const env = c.env as unknown as Record<string, unknown>;
  const { code, phone, currentCode } = c.req.valid("json");
  const { movedOrders } = await verifyAccountPhoneCode(c.get("db"), {
    accountId: session.customerId,
    code,
    phone,
    currentCode,
    // A change signs out every other session of the account; this one stays.
    currentSessionTokenHash: await hashCustomerSessionToken(token, getCustomerSessionHashKey(env)),
    encryptionKey: getCredentialEncryptionKey(env),
    credentialEncryptionKey: getCredentialEncryptionKey(env),
  });
  const added = movedOrders === 0 ? "" : movedOrders === 1 ? " 1 order was added to your account." : ` ${movedOrders} orders were added to your account.`;
  return ok(c, { movedOrders, message: `Your phone number is verified.${added}` });
});

export { app as customerPhoneRoutes };
