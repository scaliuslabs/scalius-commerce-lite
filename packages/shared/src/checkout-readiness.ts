// Checkout readiness vocabulary, shared by the API (customers' sign-in
// readiness, checkout's delivery readiness) and every reader of the
// `/settings/checkout-readiness` contract: the stable issue codes, their
// merchant copy and the typed extras the dashboard lights rows with.

import { readinessIssue, type Readiness, type ReadinessIssue } from "./readiness";

/**
 * Checkout readiness speaks the one shared vocabulary (`status` + `issues`)
 * and adds the typed extras the dashboard uses to light up individual rows.
 */
export interface CheckoutDeliveryReadiness extends Readiness {
    hasActiveShippingMethod: boolean;
    hasActiveDeliveryHierarchy: boolean;
}

export interface CheckoutReadiness extends CheckoutDeliveryReadiness {
    customerSignInRequired: boolean;
    hasUsableCustomerSignIn: boolean;
}

export interface CustomerSignInReadiness extends Readiness {
    customerSignInRequired: boolean;
    hasUsableCustomerSignIn: boolean;
}

/** Stable issue codes. Consumers match on these, never on merchant copy. */
export const CHECKOUT_READINESS_CODES = {
    shipping: "missing_active_shipping_method",
    deliveryLocation: "missing_active_delivery_location",
    customerSignIn: "unusable_customer_sign_in",
} as const;

export const CHECKOUT_READINESS_SHIPPING_ISSUE: ReadinessIssue = readinessIssue(
    CHECKOUT_READINESS_CODES.shipping,
    "Add at least one active shipping method before checkout can accept orders.",
);
export const CHECKOUT_READINESS_LOCATION_ISSUE: ReadinessIssue = readinessIssue(
    CHECKOUT_READINESS_CODES.deliveryLocation,
    "Add at least one active city with an active thana before checkout can accept orders.",
);
export const CHECKOUT_READINESS_CUSTOMER_SIGN_IN_ISSUE: ReadinessIssue = readinessIssue(
    CHECKOUT_READINESS_CODES.customerSignIn,
    "Configure a usable customer sign-in verification channel before requiring customer accounts at checkout.",
);

export const CHECKOUT_READINESS_PUBLIC_UNAVAILABLE_MESSAGE =
    "Checkout is temporarily unavailable while the merchant finishes checkout setup.";
