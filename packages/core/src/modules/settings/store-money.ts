import { settings } from "@scalius/database/schema";
import {
    DEFAULT_CURRENCY,
    getDecimalPlaces,
    normalizeSupportedCurrencyCode,
} from "@scalius/shared/currency";
import { defaultPriceIncrementMinor, type PricingCurrency } from "@scalius/shared/currency-policy";
import { PriceIncrementError, toIncrementMinor } from "@scalius/shared/money";
import { sql } from "drizzle-orm";
import { ValidationError } from "@scalius/core/errors";
import { deps } from "../../cache-deps";
import { currencyDocument } from "./documents";
import { SETTINGS_DOCUMENT_ROW_KEY } from "../../settings-store";

/**
 * The store currency as money writes need it: the shop currency's code and
 * exponent, and the price increment (the backup market's, read through
 * `readStoreCurrency` in the markets domain): merchant amounts are multiples
 * of it, derived amounts round to it.
 */
export type StoreCurrency = PricingCurrency;

/**
 * Money a merchant enters against an existing order (a refund, an amended
 * delivery charge or discount): the order's own currency, at the store's
 * price increment while the order is in the store currency, else at that
 * currency's default increment.
 */
export function orderPricePolicy<T extends { code: string; decimalPlaces: number }>(
    order: T,
    store: Pick<StoreCurrency, "code" | "priceIncrementMinor">,
): T & { priceIncrementMinor: number } {
    return { ...order, priceIncrementMinor: priceIncrementForCurrency(store, order.code) };
}

/** The price increment of an amount in `currencyCode`: the store's for its own currency, else the default. */
export function priceIncrementForCurrency(
    store: Pick<StoreCurrency, "code" | "priceIncrementMinor">,
    currencyCode: string,
): number {
    const code = currencyCode.trim().toUpperCase();
    return code === store.code ? store.priceIncrementMinor : defaultPriceIncrementMinor(code);
}

/**
 * Every merchant-entered amount (price, compare-at, fixed discount, delivery
 * charge, threshold, refund, manual adjustment) goes through here: decimal
 * major units to minor units, refused unless it is a multiple of the store's
 * price increment (a BDT store by default: "Taka amounts are whole numbers.").
 */
export function toStoreMinor(amount: number, currency: StoreCurrency): number {
    try {
        return toIncrementMinor(amount, currency.decimalPlaces, currency.priceIncrementMinor, currency.code);
    } catch (error) {
        if (error instanceof PriceIncrementError) throw new ValidationError(error.message);
        throw error;
    }
}

/**
 * The saved store currency code as a scalar subquery, so a bounded read can
 * carry its own precision without an extra statement.
 */
export function storeCurrencyCodeSql() {
    // A statement carrying this subquery reads the currency document.
    deps.settings(currencyDocument.key, SETTINGS_DOCUMENT_ROW_KEY);
    return sql<string | null>`(
        SELECT CASE WHEN json_valid(${settings.value}) THEN json_extract(${settings.value}, '$.currencyCode') END
        FROM ${settings}
        WHERE ${settings.category} = ${currencyDocument.key} AND ${settings.key} = ${SETTINGS_DOCUMENT_ROW_KEY}
    )`;
}

/** Mirrors `currencyDocument`: a missing or unsupported code means the default currency. */
export function storeCurrencyFromCode(code: unknown): string {
    return normalizeSupportedCurrencyCode(code) ?? DEFAULT_CURRENCY.code;
}

export function storeDecimalPlacesFromCode(code: unknown): number {
    return getDecimalPlaces(storeCurrencyFromCode(code));
}
