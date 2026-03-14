// packages/core/src/providers/payment/types.ts
// Payment provider interface.
//
// ============================================================================
// HOW TO ADD A NEW PAYMENT PROVIDER
// ============================================================================
//
// 1. Create a new file: providers/payment/my-gateway.ts
//
// 2. Implement the PaymentProvider interface:
//
//    import { z } from "zod";
//    import type { PaymentProvider, CreatePaymentParams, CreatePaymentResult, RefundParams, RefundResult, WebhookPayload } from "../payment/types";
//    import { registerProvider } from "../registry";
//
//    // Define your settings schema
//    const myGatewaySettingsSchema = z.object({
//      apiKey: z.string().min(1),
//      webhookSecret: z.string().min(1),
//      sandbox: z.boolean().default(false),
//    });
//    type MyGatewaySettings = z.infer<typeof myGatewaySettingsSchema>;
//
//    export class MyGatewayProvider implements PaymentProvider {
//      constructor(private settings: MyGatewaySettings) {}
//
//      async initialize() { /* optional: validate API key, etc. */ }
//      async healthCheck() { return { healthy: true }; }
//
//      async createPayment(params: CreatePaymentParams): Promise<CreatePaymentResult> {
//        // Call your gateway's API to create a payment session
//        return { transactionId: "...", redirectUrl: "..." };
//      }
//
//      async createRefund(params: RefundParams): Promise<RefundResult> {
//        return { refundId: "..." };
//      }
//
//      async verifyWebhook(rawBody: string, headers: Record<string, string>): Promise<WebhookPayload> {
//        // Verify signature and parse the payload
//        return { eventType: "payment.succeeded", data: { ... } };
//      }
//    }
//
// 3. Register the provider (at the bottom of the same file):
//
//    registerProvider(
//      {
//        id: "my-gateway",
//        name: "My Gateway",
//        type: "payment",
//        version: "1.0.0",
//        settingsSchema: myGatewaySettingsSchema,
//        description: "Accept payments via My Gateway",
//      },
//      (settings) => new MyGatewayProvider(settings),
//    );
//
// 4. Import your file from providers/payment/index.ts to ensure registration runs.
//
// 5. Done. The gateway will be available via getProvider("payment", "my-gateway", settings)
//    and will appear in getRegisteredProviders("payment").
//
// ============================================================================

import type { ProviderLifecycle, HealthCheckResult } from "../types";

// ---------------------------------------------------------------------------
// Payment-specific types
// ---------------------------------------------------------------------------

export type PaymentType = "full" | "deposit" | "balance";

/**
 * Parameters for creating a payment session.
 * Shared across all payment gateways. Gateway-specific fields are optional.
 */
export interface CreatePaymentParams {
  orderId: string;
  /** Amount in smallest currency unit (cents, paisa) for client-side gateways.
   *  For redirect-based gateways that expect whole amounts, the provider converts. */
  amount: number;
  /** ISO 4217 currency code, lowercase (e.g. "usd", "bdt") */
  currency: string;
  paymentType: PaymentType;
  /** Stripe: manual capture (authorize now, capture on fulfillment). Others ignore. */
  manualCapture?: boolean;
  /** Arbitrary metadata attached to the payment */
  metadata?: Record<string, string>;

  // --- Redirect-based gateways (SSLCommerz, etc.) ---
  successUrl?: string;
  failUrl?: string;
  cancelUrl?: string;
  /** IPN / webhook notification URL */
  ipnUrl?: string;

  // --- Customer info (some gateways require it) ---
  customerName?: string;
  customerPhone?: string;
  customerEmail?: string;
  customerAddress?: string;
  customerCity?: string;

  // --- Product info ---
  productName?: string;
  numItems?: number;
}

/**
 * Result of creating a payment session.
 * The consumer checks which fields are present to determine the flow:
 *   - clientSecret -> client-side confirmation (Stripe)
 *   - redirectUrl  -> server-side redirect (SSLCommerz, Polar)
 *   - neither      -> no online action needed (COD)
 */
export interface CreatePaymentResult {
  /** Gateway-assigned transaction/session ID */
  transactionId?: string;
  /** Client secret for client-side confirmation (e.g. Stripe) */
  clientSecret?: string;
  /** URL to redirect the customer to (e.g. SSLCommerz, Polar) */
  redirectUrl?: string;
}

/**
 * Parameters for creating a refund.
 */
export interface RefundParams {
  /** Original transaction/payment ID from the gateway */
  transactionId: string;
  /** Amount to refund in smallest currency unit. Omit for full refund. */
  amount?: number;
  /** Reason for refund (gateway-specific mapping) */
  reason?: string;
  /** Additional gateway-specific data */
  metadata?: Record<string, string>;
}

/**
 * Result of a refund operation.
 */
export interface RefundResult {
  /** Gateway-assigned refund ID */
  refundId?: string;
}

/**
 * Parsed webhook event from a payment gateway.
 */
export interface WebhookPayload {
  /** Gateway-specific event type (e.g. "payment_intent.succeeded") */
  eventType: string;
  /** The raw parsed event data */
  data: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// PaymentProvider interface
// ---------------------------------------------------------------------------

/**
 * Contract that every payment gateway must implement.
 *
 * The lifecycle methods (initialize, healthCheck, dispose) are inherited
 * from ProviderLifecycle. Payment-specific methods are defined here.
 */
export interface PaymentProvider extends ProviderLifecycle {
  /**
   * Create a payment session/intent.
   * For redirect-based gateways, returns a URL to redirect the customer to.
   * For client-side gateways (Stripe), returns a client secret.
   * For offline gateways (COD), returns a tracking transaction ID.
   */
  createPayment(params: CreatePaymentParams): Promise<CreatePaymentResult>;

  /**
   * Process a refund for a previous payment.
   * For offline gateways (COD), this may just return a reference ID.
   */
  createRefund(params: RefundParams): Promise<RefundResult>;

  /**
   * Verify a webhook signature and parse the payload.
   * Optional -- offline gateways (COD) have no webhooks.
   */
  verifyWebhook?(rawBody: string, headers: Record<string, string>): Promise<WebhookPayload>;

  /**
   * Return public configuration safe to expose to the frontend.
   * E.g. Stripe publishable key, gateway sandbox mode, etc.
   * Optional -- not all gateways need client-side config.
   */
  getPublicConfig?(): Record<string, unknown>;
}

// Re-export lifecycle types for convenience
export type { ProviderLifecycle, HealthCheckResult };
