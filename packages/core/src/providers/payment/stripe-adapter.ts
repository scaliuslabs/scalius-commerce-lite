// packages/core/src/providers/payment/stripe-adapter.ts
// Adapter: bridges the existing StripeProvider to the universal provider registry.
//
// This file does two things:
// 1. Defines a Zod settings schema for Stripe
// 2. Wraps the existing StripeProvider behind the new PaymentProvider interface
//    (adding initialize/healthCheck lifecycle methods)
// 3. Registers it with the universal registry
//
// The existing StripeProvider in modules/payments/stripe.ts is NOT modified.
// All existing imports continue to work. This adapter is additive.

import { z } from "zod";
import { registerProvider } from "../registry";
import type {
  PaymentProvider,
  CreatePaymentParams,
  CreatePaymentResult,
  RefundParams,
  RefundResult,
  WebhookPayload,
  HealthCheckResult,
} from "./types";

// Import the existing Stripe implementation
import {
  StripeProvider as LegacyStripeProvider,
} from "../../modules/payments/stripe";
import type { StripeSettings } from "../../modules/payments/gateway-settings";

// ---------------------------------------------------------------------------
// Settings schema (validates what the admin provides)
// ---------------------------------------------------------------------------

export const stripeSettingsSchema = z.object({
  secretKey: z.string().min(1, "Stripe secret key is required"),
  publishableKey: z.string().default(""),
  webhookSecret: z.string().min(1, "Stripe webhook secret is required"),
  enabled: z.boolean().default(true),
});

export type StripeProviderSettings = z.infer<typeof stripeSettingsSchema>;

// ---------------------------------------------------------------------------
// Adapter class
// ---------------------------------------------------------------------------

/**
 * Stripe adapter for the universal provider system.
 *
 * Wraps the existing StripeProvider (from modules/payments/stripe.ts)
 * and adds lifecycle methods (initialize, healthCheck).
 */
class StripePaymentProvider implements PaymentProvider {
  private legacy: LegacyStripeProvider;
  private settings: StripeProviderSettings;

  constructor(settings: StripeProviderSettings) {
    this.settings = settings;
    this.legacy = new LegacyStripeProvider(settings as StripeSettings);
  }

  // -- Lifecycle --

  async initialize(): Promise<void> {
    // The legacy provider initializes the Stripe client lazily on first use.
    // Nothing to do here.
  }

  async healthCheck(): Promise<HealthCheckResult> {
    // Quick check: verify we have credentials configured.
    // A full API call (e.g. list balance) would be more thorough but adds latency.
    if (!this.settings.secretKey) {
      return { healthy: false, message: "Stripe secret key not configured" };
    }
    return { healthy: true, message: "Stripe credentials configured" };
  }

  // -- Payment operations (delegate to legacy) --

  async createPayment(params: CreatePaymentParams): Promise<CreatePaymentResult> {
    return this.legacy.createPayment(params);
  }

  async createRefund(params: RefundParams): Promise<RefundResult> {
    return this.legacy.createRefund(params);
  }

  async verifyWebhook(rawBody: string, headers: Record<string, string>): Promise<WebhookPayload> {
    return this.legacy.verifyWebhook(rawBody, headers);
  }

  getPublicConfig(): Record<string, unknown> {
    return {
      publishableKey: this.settings.publishableKey,
    };
  }
}

// ---------------------------------------------------------------------------
// Register with the universal registry
// ---------------------------------------------------------------------------

registerProvider(
  {
    id: "stripe",
    name: "Stripe",
    type: "payment",
    version: "1.0.0",
    settingsSchema: stripeSettingsSchema,
    description: "Accept card payments via Stripe. Supports client-side confirmation, manual capture, and refunds.",
  },
  (settings) => new StripePaymentProvider(settings),
);
