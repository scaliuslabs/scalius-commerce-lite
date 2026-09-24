// Buyer-verified hosted payment recovery: send and verify the recovery OTP.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  deleteOrderPaymentRecoveryChallenge,
  sendOrderPaymentRecoveryOtp,
  verifyOrderPaymentRecoveryOtp,
} from "@scalius/core/modules/orders";
import { CUSTOMER_AUTH_OTP_CHANNELS } from "@scalius/shared/customer-auth-policy";
import { NotFoundError, ValidationError, ServiceUnavailableError } from "../../utils/api-error";
import { getCredentialEncryptionKey } from "../../utils/encryption-key";
import { ok } from "../../utils/api-response";
import { successEnvelope, errorResponses, serviceUnavailableResponse } from "../../schemas/responses";
import { authMiddleware } from "../../middleware/auth";
import { getTrustedClientIp } from "../../utils/client-ip";

const app = new OpenAPIHono<{ Bindings: Env }>();

const orderPaymentRecoveryChannelSchema = z.enum(CUSTOMER_AUTH_OTP_CHANNELS);
const ORDER_PAYMENT_RECOVERY_GENERIC_MESSAGE =
  "If this order still needs an online payment, we've sent a code to the phone number or email saved on it.";
const orderCodeSentSchema = z.object({
  message: z.string(),
  /** Masked contact the code went to ("01•••••678"); absent when nothing was sent. */
  destination: z.string().optional(),
  orderNumber: z.number().int().nullable().optional(),
  resendAfterSeconds: z.number().int().optional(),
});

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
          schema: successEnvelope(orderCodeSentSchema),
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

  return result.queued
    ? ok(c, {
      message: result.message,
      destination: result.destination,
      orderNumber: result.orderNumber,
      resendAfterSeconds: result.resendAfterSeconds,
    })
    : ok(c, { message: ORDER_PAYMENT_RECOVERY_GENERIC_MESSAGE });
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
    code: body.code,
    encryptionKey: getCredentialEncryptionKey(c.env as unknown as Record<string, unknown>),
  });

  return ok(c, result);
});

export { app as paymentRecoveryRoutes };
