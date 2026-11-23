// The store's terms at checkout: when the
// merchant requires it (Settings → Checkout), no order is placed without the
// buyer's explicit agreement, and the order records it.
import { ValidationError } from "../../errors";

/** `details.reason` of an order refused because the buyer did not agree to the terms. */
export const TERMS_ACCEPTANCE_REQUIRED_REASON = "terms_acceptance_required";

/**
 * Whether this order records the buyer's agreement: true when the store
 * requires it and the request carries `termsAccepted: true`, false when the
 * store does not require it. A required agreement that is missing refuses
 * the order.
 */
export function assertTermsAccepted(required: boolean, accepted: boolean | null | undefined): boolean {
    if (!required) return false;
    if (accepted !== true) {
        throw new ValidationError(
            "Agree to the store's terms to place this order. Show the buyer the terms, then send termsAccepted: true once they agree.",
            { field: "termsAccepted", reason: TERMS_ACCEPTANCE_REQUIRED_REASON },
        );
    }
    return true;
}
