// src/modules/payments/factory.ts
// Factory function that returns the correct PaymentProvider for a given gateway type.

import type { PaymentProvider } from "./provider";
import type { StripeSettings, SSLCommerzSettings, PolarSettings } from "./gateway-settings";
import type { Database } from "@scalius/database/client";
import { StripeProvider } from "./stripe";
import { SSLCommerzProvider } from "./sslcommerz";
import { PolarProvider } from "./polar";
import { CODProvider } from "./cod";
import { ValidationError, ServiceUnavailableError } from "@scalius/core/errors";

// ---------------------------------------------------------------------------
// Gateway config — discriminated union keyed by gateway type
// ---------------------------------------------------------------------------

export type GatewayConfig =
  | { type: "stripe"; settings: StripeSettings }
  | { type: "sslcommerz"; settings: SSLCommerzSettings }
  | { type: "polar"; settings: PolarSettings }
  | { type: "cod"; db: Database };

/**
 * Create a PaymentProvider instance for the given gateway type and configuration.
 *
 * @throws ValidationError if gateway type is unknown
 * @throws ServiceUnavailableError if gateway is disabled in settings
 */
export function createPaymentProvider(config: GatewayConfig): PaymentProvider {
  switch (config.type) {
    case "stripe": {
      if (!config.settings.enabled) {
        throw new ServiceUnavailableError("Stripe payment gateway is disabled");
      }
      return new StripeProvider(config.settings);
    }
    case "sslcommerz": {
      if (!config.settings.enabled) {
        throw new ServiceUnavailableError("SSLCommerz payment gateway is disabled");
      }
      return new SSLCommerzProvider(config.settings);
    }
    case "polar": {
      if (!config.settings.enabled) {
        throw new ServiceUnavailableError("Polar payment gateway is disabled");
      }
      return new PolarProvider(config.settings);
    }
    case "cod": {
      return new CODProvider(config.db);
    }
    default: {
      const _exhaustive: never = config;
      throw new ValidationError(`Unknown payment gateway type: ${(_exhaustive as GatewayConfig).type}`);
    }
  }
}
