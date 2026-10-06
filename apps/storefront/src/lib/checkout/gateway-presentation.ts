import { isQualifiedProviderId, parseQualifiedProviderId } from "@scalius/shared/plugins/providers/kinds";

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
  sslcommerz: {
    buyerLabel: "Pay online",
    description: "bKash, Nagad, cards and more",
    providerLabel: "SSLCommerz",
    markSrc: "/payment-marks/sslcommerz.png",
    markKind: "wordmark",
    hosted: true,
  },
  cod: {
    buyerLabel: "Cash on delivery",
    description: "Pay when you receive your order",
    providerLabel: null,
    markSrc: null,
    markKind: "none",
    hosted: false,
  },
};

/**
 * A neutral wallet: an app's payment method that ships no mark here never
 * borrows a brand asset or shows a broken image.
 */
export const APP_GATEWAY_MARK_SRC = "/payment-marks/wallet.svg";

/**
 * The first-party wallet apps' logos, by plugin id: copies of each app's
 * listing icon (`plugins/<app>/assets/icon.svg`; a test keeps them equal).
 */
export const APP_GATEWAY_MARKS: Readonly<Record<string, string>> = {
  "scalius.bkash": "/payment-marks/bkash.svg",
  "scalius.nagad": "/payment-marks/nagad.svg",
};

/** A payment method an app provides: `<plugin id>:<provider id>`. */
export function isAppGatewayId(gatewayId: string): boolean {
  return isQualifiedProviderId(gatewayId);
}

/**
 * The name buyers read for an app's method: the checkout name the store
 * serves (`GET /checkout/config`), else the provider id in words ("Bkash"
 * for `scalius.bkash:bkash`); never the stored id. Null for other methods.
 */
export function appGatewayName(
  gatewayId: string,
  gateways?: readonly { id: string; name?: unknown }[] | null,
): string | null {
  const app = parseQualifiedProviderId(gatewayId);
  if (!app) return null;
  const configured = gateways?.find((gateway) => gateway.id === gatewayId)?.name;
  if (typeof configured === "string" && configured.trim()) return configured.trim();
  const words = app.providerId.replace(/-/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function getGatewayPresentation(
  gatewayId: string,
  fallbackLabel: string,
): GatewayPresentation {
  const known = GATEWAY_PRESENTATION[gatewayId];
  if (known) return known;
  if (isAppGatewayId(gatewayId)) {
    // An app's hosted wallet: its own checkout name, and its logo or a
    // neutral mark. The name doubles as the provider in "Continue to …" copy.
    const name = fallbackLabel.trim() && fallbackLabel !== gatewayId
      ? fallbackLabel.trim()
      : appGatewayName(gatewayId) ?? fallbackLabel;
    const logo = APP_GATEWAY_MARKS[parseQualifiedProviderId(gatewayId)?.pluginId ?? ""];
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
    markSrc: null,
    markKind: "none",
    hosted: true,
  };
}
