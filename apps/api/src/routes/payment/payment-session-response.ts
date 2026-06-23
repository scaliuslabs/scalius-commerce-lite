import type { Context } from "hono";
import { z } from "@hono/zod-openapi";
import { successEnvelope } from "../../schemas/responses";
import type { PaymentSessionProcessingResponse } from "./payment-session-create";

export const paymentSessionProcessingSchema = z.object({
  status: z.literal("processing"),
  retryable: z.literal(true),
  retryAfterSeconds: z.number().int().positive(),
  orderId: z.string(),
  gateway: z.enum(["stripe", "sslcommerz", "polar"]),
  paymentType: z.enum(["full", "deposit", "balance"]),
  message: z.string(),
});

export const paymentSessionProcessingResponse = {
  description: "Payment session creation is already processing",
  content: {
    "application/json": {
      schema: successEnvelope(paymentSessionProcessingSchema),
    },
  },
} as const;

export function acceptedPaymentSessionProcessing(
  c: Context,
  data: PaymentSessionProcessingResponse,
) {
  c.header("Retry-After", String(data.retryAfterSeconds));
  c.header("Cache-Control", "no-store");
  return c.json({ success: true as const, data }, 202);
}
