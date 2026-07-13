import type { Database } from "@scalius/database/client";
import { siteSettings } from "@scalius/database/schema";
import { AppError, NotFoundError, ValidationError } from "@scalius/core/errors";
import { and, eq, sql } from "drizzle-orm";

import {
    getCheckoutFlowValidationIssues,
    type CheckoutMode,
} from "./checkout-flow";

export const CHECKOUT_FLOW_REVISION_CONFLICT = "CHECKOUT_FLOW_REVISION_CONFLICT";

export interface CheckoutFlowSettingsDocument {
    guestCheckoutEnabled: boolean;
    checkoutMode: CheckoutMode;
    partialPaymentEnabled: boolean;
    partialPaymentAmount: number;
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
    const row = await db
        .select({
            guestCheckoutEnabled: siteSettings.guestCheckoutEnabled,
            checkoutMode: siteSettings.checkoutMode,
            partialPaymentEnabled: siteSettings.partialPaymentEnabled,
            partialPaymentAmount: siteSettings.partialPaymentAmount,
            revision: siteSettings.checkoutFlowRevision,
        })
        .from(siteSettings)
        .where(eq(siteSettings.singletonKey, "default"))
        .get();

    if (!row) throw new NotFoundError("Checkout settings are not initialized");
    return row;
}

export async function saveCheckoutFlowSettingsDocument(
    db: Database,
    input: SaveCheckoutFlowSettingsInput,
): Promise<CheckoutFlowSettingsDocument> {
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) {
        throw new ValidationError("A positive checkout settings revision is required.");
    }

    const issues = getCheckoutFlowValidationIssues({
        checkoutMode: input.checkoutMode,
        partialPaymentEnabled: input.partialPaymentEnabled,
        partialPaymentAmount: input.partialPaymentAmount,
        availablePaymentMethods: input.availablePaymentMethods,
    });
    if (issues.length > 0) throw new ValidationError(issues.join(" "));

    const updated = await db
        .update(siteSettings)
        .set({
            guestCheckoutEnabled: input.guestCheckoutEnabled,
            checkoutMode: input.checkoutMode,
            partialPaymentEnabled: input.partialPaymentEnabled,
            partialPaymentAmount: input.partialPaymentAmount,
            checkoutFlowRevision: sql`${siteSettings.checkoutFlowRevision} + 1`,
            updatedAt: sql`unixepoch()`,
        })
        .where(and(
            eq(siteSettings.singletonKey, "default"),
            eq(siteSettings.checkoutFlowRevision, input.expectedRevision),
        ))
        .returning({
            guestCheckoutEnabled: siteSettings.guestCheckoutEnabled,
            checkoutMode: siteSettings.checkoutMode,
            partialPaymentEnabled: siteSettings.partialPaymentEnabled,
            partialPaymentAmount: siteSettings.partialPaymentAmount,
            revision: siteSettings.checkoutFlowRevision,
        });

    if (updated[0]) return updated[0];

    const current = await db
        .select({ revision: siteSettings.checkoutFlowRevision })
        .from(siteSettings)
        .where(eq(siteSettings.singletonKey, "default"))
        .get();
    throw new CheckoutFlowRevisionConflictError(
        input.expectedRevision,
        current?.revision ?? null,
    );
}
