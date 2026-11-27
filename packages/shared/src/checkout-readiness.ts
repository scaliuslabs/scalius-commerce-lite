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
    /** An app function the store approved as blocking is failing: checkout refuses every order that needs it. */
    appFunctionFailing: "app_function_failing",
    /** An app's cart rule refused every recent checkout by its answer. */
    appRefusingCheckout: "app_refusing_checkout",
} as const;

export const CHECKOUT_READINESS_SHIPPING_ISSUE: ReadinessIssue = readinessIssue(
    CHECKOUT_READINESS_CODES.shipping,
    "No active shipping method is configured. Physical carts need an applicable delivery or pickup option.",
);
export const CHECKOUT_READINESS_LOCATION_ISSUE: ReadinessIssue = readinessIssue(
    CHECKOUT_READINESS_CODES.deliveryLocation,
    "Bangladesh address selection has no active city with an active thana. Configure these places for deliveries in Bangladesh.",
);
export const CHECKOUT_READINESS_CUSTOMER_SIGN_IN_ISSUE: ReadinessIssue = readinessIssue(
    CHECKOUT_READINESS_CODES.customerSignIn,
    "Configure a usable customer sign-in verification channel before requiring customer accounts at checkout.",
);

export const CHECKOUT_READINESS_PUBLIC_UNAVAILABLE_MESSAGE =
    "Checkout is temporarily unavailable while the merchant finishes checkout setup.";

/** An app keeping checkout from taking orders (`listRefusingFunctions`), as checkout readiness reports it. */
export function checkoutReadinessAppIssue(app: {
    name: string;
    point: string;
    /** ISO time it began. */
    since: string;
    reason: string | null;
    failing: boolean;
}): ReadinessIssue {
    return app.failing
        ? readinessIssue(
            CHECKOUT_READINESS_CODES.appFunctionFailing,
            `Checkout is refusing orders because the app ${app.name}'s ${app.point} is failing, since ${app.since}.${app.reason ? ` Last error: ${app.reason}` : ""}`,
            `Update ${app.name}, or on its page in Apps let checkout continue when it fails, or pause the app.`,
        )
        : readinessIssue(
            CHECKOUT_READINESS_CODES.appRefusingCheckout,
            `The app ${app.name} has refused every checkout since ${app.since}.${app.reason ? ` Its latest answer to buyers: ${app.reason}` : ""}`,
            `Change ${app.name}'s settings, or pause the app.`,
        );
}
