// Adding and verifying a phone number on the customer account.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
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
import { getCredentialEncryptionKey } from "../../utils/encryption-key";
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
    appProviders: requestAppProviders(c),
  });
  await sendAuthOtp(c, c.get("db"), result.otpDelivery);
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

export { app as customerPhoneRoutes };
