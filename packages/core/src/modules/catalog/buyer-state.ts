// Buyer catalogue reads over the stored buyer state (`product_buyer_state`,
// kept by products/catalog-projections.ts in the same batch as every product,
// SKU and stock write). Listings, counts and sitemaps read its indexed rows
// instead of evaluating public eligibility and the SKU pricing window per
// request. It is a projection: live cart and checkout validation stay
// authoritative. Not exported from the domain entry.
import { products, productBuyerState, productVariants } from "@scalius/database/schema";
import { sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { resolvedBuyerDiscountSql } from "../products/buyer-projection";
import type { BuyerPricingMinor } from "../products/money";

export const buyerState = productBuyerState;

/**
 * The public buyer set: every listing, count and sitemap read starts here.
 *
 * `drivenByIdSet`: the read is narrowed by a small id set (a collection's
 * members, an `ids` lookup) that should drive it by primary key. SQLite has
 * no statistics on D1, so an indexable `is_public = 1` would win and walk
 * every public row instead; the unary `+` keeps it a filter.
 */
export function publicBuyerStateCondition(options: { drivenByIdSet?: boolean } = {}): SQL {
    return options.drivenByIdSet
        ? sql`+${buyerState.isPublic} = 1`
        : sql`${buyerState.isPublic} = 1`;
}

/** The card SKU row of a buyer state, for the card's discount fields. */
export function buyerStateCardSku() {
    return alias(productVariants, "buyer_state_card_sku");
}

export type BuyerStateCardSku = ReturnType<typeof buyerStateCardSku>;

/**
 * Card pricing columns (the `presentBuyerPricing` shape) from the stored
 * buyer state, its card SKU (left-joined on `sku_id`) and `products`.
 */
export function buyerStatePricingSelection(cardSku: BuyerStateCardSku) {
    const discount = resolvedBuyerDiscountSql({
        discountType: sql`${cardSku.discountType}`,
        discountBps: sql`${cardSku.discountBps}`,
        discountAmountMinor: sql`${cardSku.discountAmountMinor}`,
    }, {
        discountType: sql`${products.discountType}`,
        discountBps: sql`${products.discountBps}`,
        discountAmountMinor: sql`${products.discountAmountMinor}`,
    });
    return {
        basePriceMinor: sql<number>`${buyerState.baseMinor}`.as("buyer_state_base_minor"),
        discountType: discount.discountType.as("buyer_state_discount_type"),
        discountBps: discount.discountBps.as("buyer_state_discount_bps"),
        discountAmountMinor: discount.discountAmountMinor.as("buyer_state_discount_amount"),
        effectivePriceMinor: sql<number>`${buyerState.fromMinor}`.as("buyer_state_from_minor"),
        maxBuyerPriceMinor: sql<number>`${buyerState.toMinor}`.as("buyer_state_to_minor"),
    } satisfies Record<keyof BuyerPricingMinor, unknown>;
}
