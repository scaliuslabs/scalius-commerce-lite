import type { Database } from "@scalius/database/client";
import { AppError, ValidationError } from "@scalius/core/errors";

import {
    getCheckoutFlowValidationIssues,
    type CheckoutMode,
} from "./checkout-flow";
import { checkoutDocument, type CheckoutFlowSettings } from "./documents";

export const CHECKOUT_FLOW_REVISION_CONFLICT = "CHECKOUT_FLOW_REVISION_CONFLICT";

export interface CheckoutFlowSettingsDocument extends CheckoutFlowSettings {
    /** 0 until the first save. */
    revision: number;
}

export interface SaveCheckoutFlowSettingsInput {
    guestCheckoutEnabled: boolean;
    checkoutMode: CheckoutMode;
    partialPaymentEnabled: boolean;
    partialPaymentAmount: number;
    expectedRevision: number;
    availablePaymentMethods: readonly string[];
}

export class CheckoutFlowRevisionConflictError extends AppError {
    constructor(expectedRevision: number, currentRevision: number | null) {
        super(
            409,
            CHECKOUT_FLOW_REVISION_CONFLICT,
            "Checkout settings changed in another session. Review the latest version before saving again.",
            { expectedRevision, currentRevision },
        );
        this.name = "CheckoutFlowRevisionConflictError";
    }
}

export async function getCheckoutFlowSettingsDocument(
    db: Database,
): Promise<CheckoutFlowSettingsDocument> {
    const { value, revision } = await checkoutDocument.readDetailed(db);
    return { ...value, revision };
}

export async function saveCheckoutFlowSettingsDocument(
    db: Database,
    input: SaveCheckoutFlowSettingsInput,
): Promise<CheckoutFlowSettingsDocument> {
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) {
        throw new ValidationError("A non-negative checkout settings revision is required.");
    }

    const issues = getCheckoutFlowValidationIssues({
        checkoutMode: input.checkoutMode,
        partialPaymentEnabled: input.partialPaymentEnabled,
        partialPaymentAmount: input.partialPaymentAmount,
        availablePaymentMethods: input.availablePaymentMethods,
    });
    if (issues.length > 0) throw new ValidationError(issues.join(" "));

    const { value, revision } = await checkoutDocument.write(db, {
        guestCheckoutEnabled: input.guestCheckoutEnabled,
        checkoutMode: input.checkoutMode,
        partialPaymentEnabled: input.partialPaymentEnabled,
        partialPaymentAmount: input.partialPaymentAmount,
    }, {}, {
        expectedRevision: input.expectedRevision,
        conflict: (currentRevision) => new CheckoutFlowRevisionConflictError(
            input.expectedRevision,
            currentRevision,
        ),
    });
    return { ...value, revision };
}
