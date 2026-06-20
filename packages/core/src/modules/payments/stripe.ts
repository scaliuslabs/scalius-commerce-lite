// src/modules/payments/stripe.ts
// Stripe PaymentIntents API wrapper for Cloudflare Workers.
// Stripe SDK v17+ uses the Web Fetch API natively — no special config needed.

import Stripe from "stripe";
import type {
  CreateStripePaymentIntentParams,
  StripePaymentIntentResult,
} from "./types";
import type { StripeSettings } from "./gateway-settings";
import type {
  PaymentProvider,
  CreatePaymentParams,
  CreatePaymentResult,
  RefundParams,
  RefundResult,
  WebhookPayload,
} from "./provider";
import { ServiceUnavailableError, ValidationError } from "@scalius/core/errors";

// Module-level singleton — Stripe client is stateless and reusable.
// Tracks the key used to create it so credential rotations take effect.
let _stripe: Stripe | null = null;
let _stripeKey: string | null = null;

function isProviderTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const maybeError = error as { name?: unknown; message?: unknown; code?: unknown; type?: unknown };
  const name = typeof maybeError.name === "string" ? maybeError.name.toLowerCase() : "";
  const code = typeof maybeError.code === "string" ? maybeError.code.toLowerCase() : "";
  const type = typeof maybeError.type === "string" ? maybeError.type.toLowerCase() : "";
  const message = typeof maybeError.message === "string" ? maybeError.message.toLowerCase() : "";
  return (
    name.includes("timeout") ||
    name.includes("abort") ||
    code.includes("timeout") ||
    code.includes("abort") ||
    type.includes("connection") && message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("timeout") ||
    message.includes("aborted")
  );
}

export function getStripe(secretKey: string): Stripe {
  if (!_stripe || _stripeKey !== secretKey) {
    _stripe = new Stripe(secretKey);
    _stripeKey = secretKey;
  }
  return _stripe;
}

/**
 * Create a Stripe PaymentIntent for a new payment.
 *
 * By default uses automatic capture. Pass `manualCapture: true` to use
 * manual capture (authorise now, capture later on fulfilment confirmation).
 *
 * For partial payments (deposit), set the amount to the deposit amount.
 * The balance payment will create a separate PaymentIntent.
 */
export async function createPaymentIntent(
  secretKey: string,
  params: CreateStripePaymentIntentParams
): Promise<StripePaymentIntentResult> {
  try {
    const stripe = getStripe(secretKey);

    const intentParams: Stripe.PaymentIntentCreateParams = {
      amount: Math.round(params.amount), // Must be integer
      currency: params.currency.toLowerCase(),
      capture_method: params.manualCapture ? "manual" : "automatic",
      metadata: {
        orderId: params.orderId,
        paymentType: params.paymentType,
        ...params.metadata,
      },
    };

    const requestOptions: Stripe.RequestOptions = {};
    if (params.idempotencyKey) requestOptions.idempotencyKey = params.idempotencyKey;
    if (typeof params.requestTimeoutMs === "number" && params.requestTimeoutMs > 0) {
      requestOptions.timeout = params.requestTimeoutMs;
    }
    if (typeof params.maxNetworkRetries === "number" && params.maxNetworkRetries >= 0) {
      requestOptions.maxNetworkRetries = params.maxNetworkRetries;
    }

    const intent = await stripe.paymentIntents.create(intentParams, requestOptions);

    return {
      success: true,
      clientSecret: intent.client_secret ?? undefined,
      paymentIntentId: intent.id,
    };
  } catch (err: unknown) {
    if (isProviderTimeoutError(err)) {
      return {
        success: false,
        error: "Stripe did not respond before the payment timeout. Please try again.",
        timedOut: true,
      };
    }
    const message = err instanceof Stripe.errors.StripeError
      ? err.message
      : "Failed to create payment intent";
    return { success: false, error: message };
  }
}

/**
 * Capture an authorised (manual capture) PaymentIntent.
 * Call this when the order is ready for shipment/fulfilment.
 */
export async function capturePaymentIntent(
  secretKey: string,
  paymentIntentId: string,
  amountToCapture?: number
): Promise<{ success: boolean; error?: string }> {
  try {
    const stripe = getStripe(secretKey);
    const params: Stripe.PaymentIntentCaptureParams = {};
    if (amountToCapture !== undefined) {
      params.amount_to_capture = Math.round(amountToCapture);
    }
    await stripe.paymentIntents.capture(paymentIntentId, params);
    return { success: true };
  } catch (err: unknown) {
    const message = err instanceof Stripe.errors.StripeError
      ? err.message
      : "Failed to capture payment intent";
    return { success: false, error: message };
  }
}

/**
 * Cancel an uncaptured PaymentIntent (e.g. order cancelled before capture).
 */
export async function cancelPaymentIntent(
  secretKey: string,
  paymentIntentId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const stripe = getStripe(secretKey);
    await stripe.paymentIntents.cancel(paymentIntentId);
    return { success: true };
  } catch (err: unknown) {
    const message = err instanceof Stripe.errors.StripeError
      ? err.message
      : "Failed to cancel payment intent";
    return { success: false, error: message };
  }
}

/**
 * Create a refund for a captured charge.
 */
export async function createRefund(
  secretKey: string,
  chargeId: string,
  amount?: number,
  reason?: Stripe.RefundCreateParams["reason"]
): Promise<{ success: boolean; refundId?: string; error?: string }> {
  try {
    const stripe = getStripe(secretKey);
    const refund = await stripe.refunds.create({
      charge: chargeId,
      ...(amount !== undefined ? { amount: Math.round(amount) } : {}),
      ...(reason ? { reason } : {}),
    });
    return { success: true, refundId: refund.id };
  } catch (err: unknown) {
    const message = err instanceof Stripe.errors.StripeError
      ? err.message
      : "Failed to create refund";
    return { success: false, error: message };
  }
}

/**
 * Verify and parse a Stripe webhook event signature.
 * Uses `constructEventAsync` which works with Web Crypto (CF Workers).
 * Returns null if the signature is invalid.
 */
export async function verifyStripeWebhook(
  secretKey: string,
  webhookSecret: string,
  rawBody: string,
  signature: string
): Promise<Stripe.Event | null> {
  try {
    const stripe = getStripe(secretKey);
    const event = await stripe.webhooks.constructEventAsync(
      rawBody,
      signature,
      webhookSecret
    );
    return event;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// PaymentProvider implementation
// ---------------------------------------------------------------------------

/**
 * Stripe PaymentProvider implementation.
 * Wraps the existing Stripe functions behind the unified PaymentProvider interface.
 */
export class StripeProvider implements PaymentProvider {
  readonly type = "stripe" as const;
  readonly name = "Stripe";

  constructor(private readonly settings: StripeSettings) {}

  async createPayment(params: CreatePaymentParams): Promise<CreatePaymentResult> {
    const result = await createPaymentIntent(this.settings.secretKey, {
      orderId: params.orderId,
      amount: params.amount,
      currency: params.currency,
      paymentType: params.paymentType,
      manualCapture: params.manualCapture,
      metadata: params.metadata,
    });

    if (!result.success) {
      throw new ServiceUnavailableError(result.error ?? "Failed to create Stripe payment intent");
    }

    return {
      transactionId: result.paymentIntentId,
      clientSecret: result.clientSecret,
    };
  }

  async createRefund(params: RefundParams): Promise<RefundResult> {
    if (!params.transactionId) {
      throw new ValidationError("Stripe charge ID is required for refunds");
    }

    const reason = params.reason === "duplicate"
      ? "duplicate" as const
      : params.reason === "fraudulent"
        ? "fraudulent" as const
        : "requested_by_customer" as const;

    const result = await createRefund(
      this.settings.secretKey,
      params.transactionId,
      params.amount,
      reason,
    );

    if (!result.success) {
      throw new ServiceUnavailableError(result.error ?? "Failed to create Stripe refund");
    }

    return { refundId: result.refundId };
  }

  async verifyWebhook(rawBody: string, headers: Record<string, string>): Promise<WebhookPayload> {
    const signature = headers["stripe-signature"] ?? "";
    const event = await verifyStripeWebhook(
      this.settings.secretKey,
      this.settings.webhookSecret,
      rawBody,
      signature,
    );

    if (!event) {
      throw new ValidationError("Invalid Stripe webhook signature");
    }

    return {
      eventType: event.type,
      data: event.data as unknown as Record<string, unknown>,
    };
  }
}
