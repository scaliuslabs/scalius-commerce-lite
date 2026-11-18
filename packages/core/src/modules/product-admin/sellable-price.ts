// An active product sells at a price customers can pay (feeds and checkout
// reject non-positive prices): above 0 on the product and on every live SKU.
// A draft may be priced 0. Writers that plan a whole next state check it here
// for a field-level message; every guarded aggregate batch also ends with
// `buildSellablePriceGuard`, so no write path can leave a product active at 0.
import { products, productVariants } from "@scalius/database/schema";
import { buildBatchGuard, isBatchGuardError, type Database } from "@scalius/database/client";
import type { BatchItem } from "drizzle-orm/batch";
import { sql, type SQL } from "drizzle-orm";
import { ValidationError } from "@scalius/core/errors";
import { buildGiftCardProductRulesGuard, rethrowGiftCardProductRuleViolation } from "../products";

export const SELLABLE_PRICE_MESSAGE = "An active product needs a price above 0 on the product and every SKU.";

const SELLABLE_PRICE_MARKER = "PRODUCT_SELLABLE_PRICE";

/**
 * The position of the first price an active product could not sell at, or -1
 * when the state is sellable (always for a draft). `pricesMinor`: the
 * product's price and its live SKUs' prices as the write leaves them, in any
 * unit (only the sign matters).
 */
export function unsellablePriceIndex(isActive: boolean, pricesMinor: readonly number[]): number {
    return isActive ? pricesMinor.findIndex((price) => !(price > 0)) : -1;
}

/** Refuses a state an active product could not sell in. */
export function requireSellablePrice(isActive: boolean, pricesMinor: readonly number[], field = "price"): void {
    if (unsellablePriceIndex(isActive, pricesMinor) >= 0) throw new ValidationError(SELLABLE_PRICE_MESSAGE, { field });
}

/** True for the `products` row in scope priced 0 or less, on itself or on a live SKU. */
export function unpricedProductSql(): SQL {
    return sql`(
        ${products.priceMinor} <= 0
        OR EXISTS (
            SELECT 1 FROM ${productVariants}
            WHERE ${productVariants.productId} = ${products.id}
              AND ${productVariants.deletedAt} IS NULL
              AND ${productVariants.priceMinor} <= 0
        )
    )`;
}

/** Fails the batch when it leaves the live product active without a sellable price. */
export function buildSellablePriceGuard(db: Database, productId: string): BatchItem<"sqlite"> {
    return buildBatchGuard(db, sql`NOT EXISTS (
            SELECT 1 FROM ${products}
            WHERE ${products.id} = ${productId}
              AND ${products.isActive} = 1
              AND ${products.deletedAt} IS NULL
              AND ${unpricedProductSql()}
        )`, SELLABLE_PRICE_MARKER);
}

export function rethrowSellablePriceViolation(error: unknown): void {
    if (isBatchGuardError(error, SELLABLE_PRICE_MARKER)) throw new ValidationError(SELLABLE_PRICE_MESSAGE, { field: "price" });
}

/**
 * What every batch that writes a product ends with, after its writes: the
 * gift-card rules and a sellable price, checked on the state the batch leaves.
 */
export function productRuleGuards(db: Database, productId: string): BatchItem<"sqlite">[] {
    return [buildGiftCardProductRulesGuard(db, productId), buildSellablePriceGuard(db, productId)];
}

/** Rethrows a failed `productRuleGuards` guard as the validation error it stands for. */
export function rethrowProductRuleViolation(error: unknown): void {
    rethrowGiftCardProductRuleViolation(error);
    rethrowSellablePriceViolation(error);
}
