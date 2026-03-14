// src/modules/payments/provider.ts
// PaymentProvider interface — common abstraction over all payment gateways.
//
// Each gateway (Stripe, SSLCommerz, Polar, COD) implements this interface.
// The interface models what the gateways actually do:
//   - Create a payment session (returns a client secret or redirect URL)
//   - Create a refund
//   - Verify a webhook payload (optional — COD has no webhooks)

import type { PaymentGateway, PaymentType } from "./types";

// ---------------------------------------------------------------------------
// Shared param / result types for the provider interface
// ---------------------------------------------------------------------------

export interface CreatePaymentParams {
  orderId: string;
  amount: number; // In smallest currency unit (cents, paisa)
  currency: string; // ISO 4217 lowercase
  paymentType: PaymentType;
  /** Stripe: manual capture. Other gateways ignore this. */
  manualCapture?: boolean;
  /** Arbitrary metadata to attach to the payment */
  metadata?: Record<string, string>;

  // --- SSLCommerz-specific (required for redirect-based flow) ---
  successUrl?: string;
  failUrl?: string;
  cancelUrl?: string;
  ipnUrl?: string;
  customerName?: string;
  customerPhone?: string;
  customerEmail?: string;
  customerAddress?: string;
  customerCity?: string;
  productName?: string;
  numItems?: number;
}

/**
 * Result of creating a payment session.
 * Depending on the gateway, the consumer uses either:
 *   - `clientSecret` (Stripe — client-side confirmation)
 *   - `redirectUrl`  (SSLCommerz, Polar — server-side redirect)
 *   - neither        (COD — no external action needed)
 */
export interface CreatePaymentResult {
  /** Gateway-assigned transaction/session ID */
  transactionId?: string;
  /** Stripe client secret for client-side confirmation */
  clientSecret?: string;
  /** URL to redirect the customer to (SSLCommerz, Polar) */
  redirectUrl?: string;
}

export interface RefundParams {
  /** Original transaction/payment ID from the gateway */
  transactionId: string;
  /** Amount to refund in smallest currency unit. Omit for full refund. */
  amount?: number;
  reason?: string;
  /** Additional gateway-specific data */
  metadata?: Record<string, string>;
}

export interface RefundResult {
  /** Gateway-assigned refund ID */
  refundId?: string;
}

export interface WebhookPayload {
  /** Gateway-specific event type (e.g. "payment_intent.succeeded") */
  eventType: string;
  /** The raw parsed event data */
  data: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// PaymentProvider interface
// ---------------------------------------------------------------------------

export interface PaymentProvider {
  /** The gateway type identifier */
  readonly type: PaymentGateway;
  /** Human-readable gateway name */
  readonly name: string;

  /**
   * Initialize a payment session/intent.
   * For redirect-based gateways, returns a URL to redirect the customer to.
   * For client-side gateways (Stripe), returns a client secret.
   */
  createPayment(params: CreatePaymentParams): Promise<CreatePaymentResult>;

  /**
   * Process a refund for a previous payment.
   * Not all gateways support refunds (COD refunds are just status changes).
   */
  createRefund(params: RefundParams): Promise<RefundResult>;

  /**
   * Verify a webhook signature and parse the payload.
   * Optional — COD has no webhooks.
   */
  verifyWebhook?(rawBody: string, headers: Record<string, string>): Promise<WebhookPayload>;
}
