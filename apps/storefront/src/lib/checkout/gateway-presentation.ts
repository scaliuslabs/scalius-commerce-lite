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
  polar: {
    buyerLabel: "Card or digital wallet",
    description: "Complete payment with Polar",
    providerLabel: "Polar",
    markSrc: "/payment-marks/polar-black.svg",
    darkMarkSrc: "/payment-marks/polar-white.svg",
    markKind: "icon",
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

export function getGatewayPresentation(
  gatewayId: string,
  fallbackLabel: string,
): GatewayPresentation {
  return GATEWAY_PRESENTATION[gatewayId] ?? {
    buyerLabel: fallbackLabel,
    description: "",
    providerLabel: null,
    markSrc: null,
    markKind: "none",
    hosted: true,
  };
}
