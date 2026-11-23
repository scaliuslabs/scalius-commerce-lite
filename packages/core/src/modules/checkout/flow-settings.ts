import type { Database } from "@scalius/database/client";
import { ValidationError } from "@scalius/core/errors";

import type { PaymentProviders } from "../payments";
import { getCheckoutFlowValidationIssues } from "./flow";
import { type AutoFulfilMode, checkoutDocument, type CheckoutFlowSettings, type CheckoutMode, toStoreMinor } from "../settings";
import { readStoreCurrency } from "../markets";

export interface CheckoutFlowSettingsDocument extends CheckoutFlowSettings {
    /** 0 until the first save. */
    revision: number;
}

export interface SaveCheckoutFlowSettingsInput {
    guestCheckoutEnabled: boolean;
    checkoutMode: CheckoutMode;
    partialPaymentEnabled: boolean;
    partialPaymentAmount: number;
    /** Omitted = keep the saved mode (Settings → Checkout → Downloads and gift cards sends it). */
    autoFulfilMode?: AutoFulfilMode;
    /** Omitted = keep the saved choice. */
    requireFullBillingAddress?: boolean;
    /** Omitted = keep the saved choice. */
    requireTermsAcceptance?: boolean;
    expectedRevision: number;
    availablePaymentMethods: readonly string[];
    /** The request's gateways, for app gateways' amount limits. */
    paymentProviders?: PaymentProviders;
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

    const storeCurrency = await readStoreCurrency(db);
    const issues = getCheckoutFlowValidationIssues({
        checkoutMode: input.checkoutMode,
        partialPaymentEnabled: input.partialPaymentEnabled,
        partialPaymentAmount: input.partialPaymentAmount,
        availablePaymentMethods: input.availablePaymentMethods,
        paymentProviders: input.paymentProviders,
        currencyCode: storeCurrency.code,
    });
    if (issues.length > 0) throw new ValidationError(issues.join(" "));
    // The advance a buyer pays online is money like any other: whole taka in BDT.
    if (input.partialPaymentEnabled) toStoreMinor(input.partialPaymentAmount, storeCurrency);

    const { value, revision } = await checkoutDocument.write(db, {
        guestCheckoutEnabled: input.guestCheckoutEnabled,
        checkoutMode: input.checkoutMode,
        partialPaymentEnabled: input.partialPaymentEnabled,
        partialPaymentAmount: input.partialPaymentAmount,
        ...(input.autoFulfilMode === undefined ? {} : { autoFulfilMode: input.autoFulfilMode }),
        ...(input.requireFullBillingAddress === undefined ? {} : { requireFullBillingAddress: input.requireFullBillingAddress }),
        ...(input.requireTermsAcceptance === undefined ? {} : { requireTermsAcceptance: input.requireTermsAcceptance }),
    }, {}, { expectedRevision: input.expectedRevision });
    return { ...value, revision };
}
