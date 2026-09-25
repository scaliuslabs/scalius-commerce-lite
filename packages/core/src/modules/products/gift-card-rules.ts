// Gift-card product rules (Wave B design §4.2): a gift-card product sells
// fixed denominations, so every live SKU is digital, untracked, and neither
// the product nor any SKU carries a discount (the card's value is its base
// price). The editor forces the kind and tracking; the API refuses
// contradicting input, and every aggregate batch ends with a guard so no
// write path (variants, option matrix, pricing section) can break the rule.
import { products, productVariants } from "@scalius/database/schema";
import { buildBatchGuard, type Database } from "@scalius/database/client";
import type { BatchItem } from "drizzle-orm/batch";
import { sql } from "drizzle-orm";
import type { z } from "zod";
import { ValidationError } from "@scalius/core/errors";

export const GIFT_CARD_PRODUCT_RULES_MARKER = "GIFT_CARD_PRODUCT_RULES";

export const GIFT_CARD_PRODUCT_RULES_MESSAGE =
    "Gift cards are digital, don't track quantity and can't be discounted. Change the variants and discounts, then save again.";

/** Fails the batch when the product is a gift card and breaks a rule. */
export function buildGiftCardProductRulesGuard(db: Database, productId: string): BatchItem<"sqlite"> {
    return buildBatchGuard(db, sql`NOT EXISTS (
            SELECT 1 FROM ${products}
            WHERE ${products.id} = ${productId}
              AND ${products.isGiftCard} = 1
              AND (
                ${products.discountBps} > 0
                OR ${products.discountAmountMinor} > 0
                OR EXISTS (
                    SELECT 1 FROM ${productVariants}
                    WHERE ${productVariants.productId} = ${productId}
                      AND ${productVariants.deletedAt} IS NULL
                      AND (
                        ${productVariants.fulfillmentKind} <> 'digital'
                        OR ${productVariants.trackInventory} = 1
                        OR ${productVariants.discountBps} > 0
                        OR ${productVariants.discountAmountMinor} > 0
                      )
                )
              )
        )`, GIFT_CARD_PRODUCT_RULES_MARKER);
}

function errorText(error: unknown, depth = 0): string {
    if (depth > 5 || error === null || error === undefined) return "";
    if (typeof error !== "object") return String(error);
    const candidate = error as { message?: unknown; cause?: unknown };
    return `${typeof candidate.message === "string" ? candidate.message : ""} ${errorText(candidate.cause, depth + 1)}`;
}

/**
 * Rethrows a failed gift-card guard as a validation error. Only an error that
 * names the marker is translated: a bare "malformed JSON" could be any guard.
 */
export function rethrowGiftCardProductRuleViolation(error: unknown): void {
    if (errorText(error).includes(GIFT_CARD_PRODUCT_RULES_MARKER)) {
        throw new ValidationError(GIFT_CARD_PRODUCT_RULES_MESSAGE, { field: "isGiftCard" });
    }
}

type Discounted = {
    discountPercentage?: number | null;
    discountAmount?: number | null;
};

function hasDiscount(value: Discounted): boolean {
    return (value.discountPercentage ?? 0) > 0 || (value.discountAmount ?? 0) > 0;
}

type GiftCardSkuInput = Discounted & {
    trackInventory?: boolean;
    stock?: number;
    fulfillmentKind?: string;
};

/** Field-level issues for create/update input that marks the product a gift card. */
export function addGiftCardInputIssues(
    value: Discounted & {
        isGiftCard?: boolean;
        fulfillmentKind?: string;
        defaultSku?: GiftCardSkuInput;
        optionMatrix?: { variants: readonly GiftCardSkuInput[] };
    },
    context: z.RefinementCtx,
): void {
    if (value.isGiftCard !== true) return;
    if (hasDiscount(value)) {
        context.addIssue({ code: "custom", path: ["discountPercentage"], message: "Gift cards can't be discounted. Set the discount to 0." });
    }
    if (value.fulfillmentKind !== undefined && value.fulfillmentKind !== "digital") {
        context.addIssue({ code: "custom", path: ["fulfillmentKind"], message: "Gift cards are delivered digitally." });
    }
    const skuIssues = (sku: GiftCardSkuInput, path: Array<string | number>) => {
        if (sku.fulfillmentKind !== undefined && sku.fulfillmentKind !== "digital") {
            context.addIssue({ code: "custom", path: [...path, "fulfillmentKind"], message: "Gift cards are delivered digitally." });
        }
        if (sku.trackInventory === true || (sku.stock ?? 0) > 0) {
            context.addIssue({ code: "custom", path: [...path, "trackInventory"], message: "Gift cards don't track quantity. Turn off quantity tracking." });
        }
        if (hasDiscount(sku)) {
            context.addIssue({ code: "custom", path: [...path, "discountPercentage"], message: "Gift cards can't be discounted. Set the discount to 0." });
        }
    };
    if (value.defaultSku) skuIssues(value.defaultSku, ["defaultSku"]);
    value.optionMatrix?.variants.forEach((variant, index) => skuIssues(variant, ["optionMatrix", "variants", index]));
}
