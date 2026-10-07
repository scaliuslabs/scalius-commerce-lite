import { isQualifiedProviderId, parseQualifiedProviderId } from "@scalius/shared/plugins/providers/kinds";
import { currentPaymentMethodId, RETIRED_PAYMENT_METHODS } from "@scalius/shared/plugins/providers/retired-payments";

/** The Bangladesh pack's SSLCommerz (`sslcommerz` on orders paid before it moved there). */
export const SSLCOMMERZ_GATEWAY_ID = RETIRED_PAYMENT_METHODS.sslcommerz!.replacement;

export type GatewayPresentation = {
  buyerLabel: string;
  description: string;
  providerLabel: string | null;
  markSrc: string | null;
  darkMarkSrc?: string;
  markKind: "wordmark" | "icon" | "none";
  hosted: boolean;
};

/**
 * Buyer-facing payment names stay stable and familiar. Provider marks are
 * exact, locally bundled first-party assets copied from the audited admin
 * manifest; capability copy is limited to the public gateway contract.
 */
export const GATEWAY_PRESENTATION: Record<string, GatewayPresentation> = {
  stripe: {
    buyerLabel: "Credit or debit card",
    description: "Pay securely by card",
    providerLabel: "Stripe",
    markSrc: "/payment-marks/stripe-blurple.svg",
    markKind: "wordmark",
    hosted: false,
  },
  // The Bangladesh pack's SSLCommerz (also `sslcommerz`, its id before the
  // move): its page offers cards, wallets and banking, so buyers read it as
  // paying online; its mark is a copy of the one the pack declares.
  [SSLCOMMERZ_GATEWAY_ID]: {
    buyerLabel: "Pay online",
    description: "bKash, Nagad, cards and more",
    providerLabel: "SSLCommerz",
    markSrc: "/payment-marks/sslcommerz.png",
    markKind: "wordmark",
    hosted: true,
  },
  // Every method shows a mark in the same badge (Shopify's payment rows):
  // methods without a brand show a plain icon.
  cod: {
    buyerLabel: "Cash on delivery",
    description: "Pay when you receive your order",
    providerLabel: null,
    markSrc: "/payment-marks/cash.svg",
    markKind: "icon",
    hosted: false,
  },
  gift_card: {
    buyerLabel: "Gift card",
    description: "",
    providerLabel: null,
    markSrc: "/payment-marks/gift.svg",
    markKind: "icon",
    hosted: false,
  },
};

/**
 * A neutral wallet: an app's payment method that ships no mark here never
 * borrows a brand asset or shows a broken image.
 */
export const APP_GATEWAY_MARK_SRC = "/payment-marks/wallet.svg";

/**
 * The first-party apps' payment providers' marks, by provider id: copies of
 * the mark each declares (`providers.payment[].icon`; a test keeps them equal).
 */
export const APP_PROVIDER_MARKS: Readonly<Record<string, string>> = {
  [SSLCOMMERZ_GATEWAY_ID]: "/payment-marks/sslcommerz.png",
  "scalius.bkash:bkash": "/payment-marks/bkash.svg",
  "scalius.nagad:nagad": "/payment-marks/nagad.svg",
};

/** The name a retired id's replacement had as a built-in gateway ("SSLCommerz"), or null. */
function retiredProviderName(gatewayId: string): string | null {
  return Object.values(RETIRED_PAYMENT_METHODS).find((entry) => entry.replacement === gatewayId)?.name ?? null;
}

/** A payment method an app provides: `<plugin id>:<provider id>`, or a retired built-in id one replaced. */
export function isAppGatewayId(gatewayId: string): boolean {
  return isQualifiedProviderId(currentPaymentMethodId(gatewayId));
}

/**
 * The name buyers read for an app's method: the checkout name the store
 * serves (`GET /checkout/config`), else the provider id in words ("Bkash"
 * for `scalius.bkash:bkash`); never the stored id. Null for other methods.
 */
export function appGatewayName(
  storedId: string,
  gateways?: readonly { id: string; name?: unknown }[] | null,
): string | null {
  const gatewayId = currentPaymentMethodId(storedId);
  const app = parseQualifiedProviderId(gatewayId);
  if (!app) return null;
  const configured = gateways?.find((gateway) => gateway.id === gatewayId)?.name;
  if (typeof configured === "string" && configured.trim()) return configured.trim();
  const known = retiredProviderName(gatewayId);
  if (known) return known;
  const words = app.providerId.replace(/-/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function getGatewayPresentation(
  gatewayId: string,
  fallbackLabel: string,
): GatewayPresentation {
  const known = GATEWAY_PRESENTATION[currentPaymentMethodId(gatewayId)];
  if (known) return known;
  if (isAppGatewayId(gatewayId)) {
    // An app's hosted wallet: its own checkout name, and its provider's mark
    // or a neutral one. The name doubles as the provider in "Continue to …" copy.
    const id = currentPaymentMethodId(gatewayId);
    const name = fallbackLabel.trim() && fallbackLabel !== gatewayId
      ? fallbackLabel.trim()
      : appGatewayName(id) ?? fallbackLabel;
    const logo = APP_PROVIDER_MARKS[id];
    return {
      buyerLabel: name,
      description: "",
      providerLabel: null,
      markSrc: logo ?? APP_GATEWAY_MARK_SRC,
      markKind: logo ? "wordmark" : "icon",
      hosted: true,
    };
  }
  return {
    buyerLabel: fallbackLabel,
    description: "",
    providerLabel: null,
    markSrc: APP_GATEWAY_MARK_SRC,
    markKind: "icon",
    hosted: true,
  };
}

/** SSLCommerz in the buyer's language ("Continue to SSLCommerz" keeps the provider's name). */
export function sslcommerzPresentation(
  presentation: GatewayPresentation,
  copy: { onlinePaymentText: string; onlinePaymentDescriptionText: string },
): GatewayPresentation {
  return { ...presentation, buyerLabel: copy.onlinePaymentText, description: copy.onlinePaymentDescriptionText };
}
