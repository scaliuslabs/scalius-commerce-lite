// Catalog prices are integer minor units of the store currency (locked once
// products exist). Reads convert them to the decimal HTTP contract here.

import type { Database } from "@scalius/database/client";
import { bpsToPercent, discountedPriceMinor, fromMinor, percentToBps, toMinor } from "@scalius/shared/money";
import { sql, type SQL } from "drizzle-orm";
import { settings } from "@scalius/database/schema";
import {
    DEFAULT_CURRENCY,
    getDecimalPlaces,
    normalizeSupportedCurrencyCode,
    SUPPORTED_CURRENCY_CODES,
} from "@scalius/shared/currency";
import { currencyDocument } from "../settings/documents";
import { getCurrencyConfig } from "../settings/settings.service";
import { SETTINGS_DOCUMENT_ROW_KEY } from "../settings/settings-store";
import type { BuyerCatalogPricingProjection } from "./products.buyer-projection";

export interface CatalogPriceMinor {
    priceMinor: number;
    discountType: string | null;
    discountBps: number | null;
    discountAmountMinor: number | null;
}

export async function readStoreDecimalPlaces(db: Database): Promise<number> {
    return (await getCurrencyConfig(db)).decimalPlaces;
}

/**
 * The saved store currency code as a scalar subquery, so a bounded read can
 * carry its own precision without an extra statement.
 */
export function storeCurrencyCodeSql() {
    return sql<string | null>`(
        SELECT CASE WHEN json_valid(${settings.value}) THEN json_extract(${settings.value}, '$.currencyCode') END
        FROM ${settings}
        WHERE ${settings.category} = ${currencyDocument.key} AND ${settings.key} = ${SETTINGS_DOCUMENT_ROW_KEY}
    )`;
}

/** Mirrors `currencyDocument`: a missing or unsupported code means the default currency. */
export function storeDecimalPlacesFromCode(code: unknown): number {
    return getDecimalPlaces(normalizeSupportedCurrencyCode(code) ?? DEFAULT_CURRENCY.code);
}

const DEFAULT_MINOR_SCALE = 10 ** getDecimalPlaces(DEFAULT_CURRENCY.code);
// Supported codes are fixed ISO literals, so they are inlined rather than bound.
const STORE_MINOR_SCALE_CASES = SUPPORTED_CURRENCY_CODES
    .filter((code) => 10 ** getDecimalPlaces(code) !== DEFAULT_MINOR_SCALE)
    .map((code) => `WHEN '${code}' THEN ${10 ** getDecimalPlaces(code)}`)
    .join(" ");

/**
 * A decimal amount from a request in store-currency minor units, resolved in
 * SQL so a catalog read needs no separate currency lookup. Mirrors
 * `storeDecimalPlacesFromCode`; used only for filter bounds.
 */
export function storeDecimalToMinorSql(amount: number): SQL<number> {
    const scale = sql.raw(`(CASE upper(trim(coalesce(`)
        .append(storeCurrencyCodeSql())
        .append(sql.raw(`, ''))) ${STORE_MINOR_SCALE_CASES} ELSE ${DEFAULT_MINOR_SCALE} END)`));
    return sql<number>`CAST(round(CAST(${amount} AS DOUBLE PRECISION) * ${scale}) AS INTEGER)`;
}

/** Replaces stored catalog money columns with the decimal fields of the HTTP contract. */
export function presentCatalogPrice<T extends CatalogPriceMinor>(row: T, decimalPlaces: number) {
    const { priceMinor, discountBps, discountAmountMinor, ...rest } = row;
    return {
        ...rest,
        price: fromMinor(priceMinor, decimalPlaces),
        discountPercentage: bpsToPercent(discountBps ?? 0),
        discountAmount: fromMinor(discountAmountMinor ?? 0, decimalPlaces),
    };
}

export function catalogDiscountedPrice(row: CatalogPriceMinor, decimalPlaces: number): number {
    return fromMinor(
        discountedPriceMinor(row.priceMinor, row.discountType, row.discountBps, row.discountAmountMinor),
        decimalPlaces,
    );
}

/**
 * SQL twin of `discountedPriceMinor`: a SKU's own discount wins over the
 * product discount; percentage prices round half-up in integer arithmetic.
 */
export function effectivePriceMinorSql(sku: {
    priceMinor: SQL;
    discountType: SQL;
    discountBps: SQL;
    discountAmountMinor: SQL;
}, product: {
    discountType: SQL;
    discountBps: SQL;
    discountAmountMinor: SQL;
}): SQL<number> {
    return sql<number>`CASE
        WHEN ${sku.discountType} = 'flat' AND ${sku.discountAmountMinor} > 0
            THEN MAX(${sku.priceMinor} - ${sku.discountAmountMinor}, 0)
        WHEN ${sku.discountType} = 'percentage' AND ${sku.discountBps} > 0
            THEN (${sku.priceMinor} * (10000 - MIN(${sku.discountBps}, 10000)) + 5000) / 10000
        WHEN ${product.discountType} = 'flat' AND ${product.discountAmountMinor} > 0
            THEN MAX(${sku.priceMinor} - ${product.discountAmountMinor}, 0)
        WHEN ${product.discountType} = 'percentage' AND ${product.discountBps} > 0
            THEN (${sku.priceMinor} * (10000 - MIN(${product.discountBps}, 10000)) + 5000) / 10000
        ELSE ${sku.priceMinor}
    END`;
}

export interface BuyerPricingMinor {
    basePriceMinor: number;
    discountType: string | null;
    discountBps: number | null;
    discountAmountMinor: number | null;
    effectivePriceMinor: number;
    maxBuyerPriceMinor: number;
}

/** Columns every buyer card reads from `buildBuyerCatalogPricingProjection`. */
export function buyerPricingSelection(pricing: BuyerCatalogPricingProjection) {
    return {
        basePriceMinor: pricing.basePriceMinor,
        discountType: pricing.discountType,
        discountBps: pricing.discountBps,
        discountAmountMinor: pricing.discountAmountMinor,
        effectivePriceMinor: pricing.effectivePriceMinor,
        maxBuyerPriceMinor: pricing.maxBuyerPriceMinor,
    };
}

/** Buyer card pricing in the decimal HTTP contract. */
export function presentBuyerPricing<T extends BuyerPricingMinor>(row: T, decimalPlaces: number) {
    const {
        basePriceMinor,
        discountBps,
        discountAmountMinor,
        effectivePriceMinor,
        maxBuyerPriceMinor,
        ...rest
    } = row;
    return {
        ...rest,
        price: fromMinor(basePriceMinor, decimalPlaces),
        discountPercentage: bpsToPercent(discountBps ?? 0),
        discountAmount: fromMinor(discountAmountMinor ?? 0, decimalPlaces),
        discountedPrice: fromMinor(effectivePriceMinor, decimalPlaces),
        priceVaries: maxBuyerPriceMinor > effectivePriceMinor,
    };
}

export interface CatalogPriceInput {
    price?: number;
    discountPercentage?: number | null;
    discountAmount?: number | null;
}

/** Decimal catalog price fields from a request as stored minor-unit columns (only the fields present). */
export function catalogPriceColumns(input: CatalogPriceInput, decimalPlaces: number) {
    return {
        ...(input.price !== undefined ? { priceMinor: toMinor(input.price, decimalPlaces) } : {}),
        ...(input.discountPercentage !== undefined
            ? { discountBps: percentToBps(input.discountPercentage) }
            : {}),
        ...(input.discountAmount !== undefined
            ? { discountAmountMinor: input.discountAmount == null ? 0 : toMinor(input.discountAmount, decimalPlaces) }
            : {}),
    };
}
