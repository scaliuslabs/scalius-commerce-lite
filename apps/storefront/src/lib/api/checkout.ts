// src/lib/api/checkout.ts
// Fetches checkout configuration from the backend (enabled payment gateways).

import { getConfiguredSdkClient } from "./transport";
import { withEdgeCache, CACHE_TTL } from "@/lib/api/transport";
import { unwrapData } from "./unwrap";
import { getApiV1CheckoutConfig } from "@scalius/api-client/sdk";
import type {
  CustomerAuthMethod,
  CustomerAuthPolicyConfig,
} from "@scalius/shared/customer-auth-policy";
import type { Readiness } from "@scalius/shared/readiness";

export interface GatewayConfig {
  /** A registered gateway id or "cod". */
  id: string;
  name: string;
  /** card: Stripe.js confirms in the browser; hosted: redirect to the provider; cod: no online payment. */
  flow?: "card" | "hosted" | "cod";
  publishableKey?: string;   // Stripe only
  currencies?: string[];
  testMode?: boolean;
  amountLimits?: {
    currency: string;
    min: number;
    max: number;
  };
  /** @deprecated Transitional fallback for cached SSLCommerz config. */
  sandbox?: boolean;
}

export interface CheckoutConfig {
  gateways: GatewayConfig[];
  activeDefaultMethod?: GatewayConfig["id"];
  guestCheckoutEnabled?: boolean;
  authVerificationMethod?: CustomerAuthMethod;
  customerAuthPolicy?: CustomerAuthPolicyConfig;
  checkoutMode?: "guest_cod_only" | "gateways_only" | "all";
  partialPaymentEnabled?: boolean;
  partialPaymentAmount?: number;
  allowedCountries?: string[];
  allowedCountriesMode?: "include" | "exclude";
  currency?: {
    code: string;
    symbol: string;
    decimalPlaces: number;
  };
  checkoutReadiness?: Readiness & {
    hasActiveShippingMethod: boolean;
    hasActiveDeliveryHierarchy: boolean;
  };
  unavailable?: boolean;
  unavailableMessage?: string;
}

const CHECKOUT_UNAVAILABLE: CheckoutConfig = {
  gateways: [],
  guestCheckoutEnabled: false,
  authVerificationMethod: "email",
  checkoutMode: "all",
  partialPaymentEnabled: false,
  partialPaymentAmount: 0,
  unavailable: true,
  unavailableMessage: "Checkout is temporarily unavailable. Please try again shortly.",
};

/**
 * Get active payment gateway configuration from the backend. Concurrent SSR
 * reads share one in-flight request; the API remains the cache authority.
 * Backend/API failures fail closed instead of guessing COD availability.
 */
export async function getCheckoutConfig(): Promise<CheckoutConfig> {
  const result = await withEdgeCache<CheckoutConfig>(
    "checkout_config",
    async () => {
      try {
        const { data } = await getApiV1CheckoutConfig({
          client: getConfiguredSdkClient(),
        });
        return unwrapData<CheckoutConfig>(data);
      } catch (err: unknown) {
        console.error("[checkout] Failed to fetch gateway config:", err);
        return null;
      }
    },
    { ttlSeconds: CACHE_TTL.SHORT },
  );
  return result ?? CHECKOUT_UNAVAILABLE;
}

/**
 * Check if only COD is active (simple COD-only flow).
 * If advance partial payments are enabled, this flow is disabled because a gateway is required.
 */
export function isCodOnly(config: CheckoutConfig): boolean {
  if (config.unavailable) return false;
  if (config.partialPaymentEnabled) return false;
  return config.gateways.length === 1 && config.gateways[0].id === "cod";
}
