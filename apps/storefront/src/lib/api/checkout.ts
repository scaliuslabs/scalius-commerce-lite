// src/lib/api/checkout.ts
// Fetches checkout configuration from the backend (enabled payment gateways).

import { getConfiguredSdkClient } from "./transport";
import { withEdgeCache, CACHE_TTL } from "@/lib/api/transport";
import { unwrapData } from "./unwrap";
import { getApiV1CheckoutConfig } from "@scalius/api-client/sdk";
import type { CustomerIdentitySettings } from "@scalius/shared/customer-auth-policy";
import type { Readiness } from "@scalius/shared/readiness";
import { paymentMethodFits } from "@scalius/shared/fulfilment";

export interface GatewayConfig {
  /** A registered gateway id or "cod". */
  id: string;
  name: string;
  /**
   * card: Stripe.js confirms in the browser; hosted: redirect to the provider;
   * cod: no online payment; deferred: pay later by its due date (an invoice),
   * offered only when the buyer's quote allows it.
   */
  flow?: "card" | "hosted" | "cod" | "deferred";
  /** How its money reaches the store; `cash_on_delivery` never pays for a key, a download or a gift card. */
  paymentKind?: "cash_on_delivery" | "invoice" | "paid_to_store" | "gift_card" | "online";
  /** A deferred method's terms: the order is due this many days after it is placed. */
  dueInDays?: number;
  publishableKey?: string;   // Stripe only
  currencies?: string[];
  /** The delivery countries it serves, when not every country (cash on delivery: ["BD"]). */
  countries?: string[];
  testMode?: boolean;
  amountLimits?: {
    currency: string;
    min: number;
    max: number;
  };
}

export interface CheckoutConfig {
  gateways: GatewayConfig[];
  activeDefaultMethod?: GatewayConfig["id"];
  guestCheckoutEnabled?: boolean;
  /** Settings → Customer accounts; `channels` are only chosen ones that can send. */
  customerIdentity?: CustomerIdentitySettings;
  checkoutMode?: "guest_cod_only" | "gateways_only" | "all";
  partialPaymentEnabled?: boolean;
  partialPaymentAmount?: number;
  /** Settings → Checkout: every order asks for a full billing address (absent: off). */
  requireFullBillingAddress?: boolean;
  /** Settings → Checkout: the buyer ticks "I agree to the terms" before the order is placed (absent: off). */
  requireTermsAcceptance?: boolean;
  /** The store holds a live gift card (`cashUnpayableHere`). */
  giftCardsLive?: boolean;
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
  /**
   * Settings → Customers → Marketing consent: the checkbox checkout shows
   * (unchecked, never required) with the merchant's label per language.
   * Absent from an older API: no checkbox.
   */
  marketingConsent?: {
    enabled: boolean;
    channels: Array<"email" | "sms" | "whatsapp">;
    label: { en: string; bn: string };
  };
}

const CHECKOUT_UNAVAILABLE: CheckoutConfig = {
  gateways: [],
  guestCheckoutEnabled: false,
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
 * Whether `getCheckoutConfig` fell back to the fail-closed config because the
 * read failed, as opposed to the store's own saved "unavailable" answer. A
 * page rendered from the fallback must not be stored in the shared cache.
 */
export function isCheckoutConfigReadFailure(config: CheckoutConfig): boolean {
  return config === CHECKOUT_UNAVAILABLE;
}

/**
 * Whether checkout can take an order at all: its config was read, it is not
 * unavailable, and some payment method is usable. Otherwise checkout refuses
 * every order and says so itself, so no other surface adds its own reason.
 */
export function checkoutTakesOrders(config: CheckoutConfig | null | undefined): boolean {
  return Boolean(config) && !isCheckoutConfigReadFailure(config!) && config!.unavailable !== true && config!.gateways.length > 0;
}

/**
 * Whether the store lists a way to pay other than cash (`paymentMethodFits`
 * by kind, the server's one rule): a card, a hosted gateway, the invoice or
 * an app's pay-later method that is not cash. An unavailable or unread
 * checkout answers true: it refuses every order and says so itself.
 */
export function listsNonCashPayment(config: CheckoutConfig | null | undefined): boolean {
  if (!config || config.unavailable) return true;
  return config.gateways.some((gateway) => paymentMethodFits(gateway.paymentKind ?? (gateway.flow === "cod" ? "cash_on_delivery" : "online"), false));
}

/**
 * On a store that lists no way to pay but cash, what a SKU cash can't pay for
 * (core's `cashPayable` false: a key, a download, a gift card, a kit holding
 * one) needs a gift card: `"stopped"` when the store holds no live gift card
 * (`giftCardsLive`: nobody can pay, so buying is off), `"gift_card"` when it
 * does (buying stays on; a gift card pays), `null` otherwise (the SKU is cash
 * payable, or the store lists a gateway or a pay-later method). An
 * unavailable or unread checkout answers null: it says so itself.
 */
export function cashUnpayableHere(
  cashPayable: boolean | null | undefined,
  config: CheckoutConfig | null | undefined,
): "stopped" | "gift_card" | null {
  if (cashPayable !== false || listsNonCashPayment(config)) return null;
  return config?.giftCardsLive === true ? "gift_card" : "stopped";
}

/** `cashUnpayableHere` for a page: only when none of its SKUs is cash payable (one that is keeps the page buyable). */
export function pageCashUnpayableHere(
  variants: ReadonlyArray<{ cashPayable?: boolean | null }>,
  config: CheckoutConfig | null | undefined,
): "stopped" | "gift_card" | null {
  if (variants.length === 0 || !variants.every((variant) => variant.cashPayable === false)) return null;
  return cashUnpayableHere(false, config);
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

/**
 * Whether the cart page may place cash on delivery itself: the store takes
 * cash and asks no advance. It does when cash is the store's only method, or
 * the only one a buyer's quote leaves (codPaymentStep).
 */
export function canPlaceCashHere(config: CheckoutConfig): boolean {
  if (config.unavailable || config.partialPaymentEnabled) return false;
  return config.gateways.some((gateway) => gateway.id === "cod");
}
