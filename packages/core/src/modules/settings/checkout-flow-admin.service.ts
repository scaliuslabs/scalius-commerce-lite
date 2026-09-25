import type { Database } from "@scalius/database/client";
import { ValidationError } from "@scalius/core/errors";

import { getCheckoutFlowValidationIssues } from "./checkout-flow";
import { checkoutDocument, type AutoFulfilMode, type CheckoutFlowSettings, type CheckoutMode } from "./documents";
import { readStoreCurrency, toStoreMinor } from "./store-money";

export interface CheckoutFlowSettingsDocument extends CheckoutFlowSettings {
    /** 0 until the first save. */
    revision: number;
}

export interface SaveCheckoutFlowSettingsInput {
    guestCheckoutEnabled: boolean;
    checkoutMode: CheckoutMode;
    partialPaymentEnabled: boolean;
    partialPaymentAmount: number;
    /** Omitted = keep the saved mode (the dashboard offers it once Wave B delivery lands). */
    autoFulfilMode?: AutoFulfilMode;
    expectedRevision: number;
    availablePaymentMethods: readonly string[];
}

export async function getCheckoutFlowSettingsDocument(
    db: Database,
): Promise<CheckoutFlowSettingsDocument> {
    const { value, revision } = await checkoutDocument.readDetailed(db, {}, { skipCache: true });
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
    // The advance a buyer pays online is money like any other: whole taka in BDT.
    if (input.partialPaymentEnabled) toStoreMinor(input.partialPaymentAmount, await readStoreCurrency(db));

    const { value, revision } = await checkoutDocument.write(db, {
        guestCheckoutEnabled: input.guestCheckoutEnabled,
        checkoutMode: input.checkoutMode,
        partialPaymentEnabled: input.partialPaymentEnabled,
        partialPaymentAmount: input.partialPaymentAmount,
        ...(input.autoFulfilMode === undefined ? {} : { autoFulfilMode: input.autoFulfilMode }),
    }, {}, { expectedRevision: input.expectedRevision });
    return { ...value, revision };
}
