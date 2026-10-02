import type { Database } from "@scalius/database/client";
import { settings } from "@scalius/database/schema";
import { DEFAULT_CURRENCY, getDecimalPlaces, normalizeSupportedCurrencyCode } from "@scalius/shared/currency";
import { toCashMinor, WholeCashAmountError } from "@scalius/shared/money";
import { sql } from "drizzle-orm";
import { ValidationError } from "@scalius/core/errors";
import { deps } from "../../cache-deps";
import { currencyDocument } from "./documents";
import { getCurrencyConfig } from "./settings.service";
import { SETTINGS_DOCUMENT_ROW_KEY } from "./settings-store";

/** The store currency as money writes need it. */
export interface StoreCurrency {
    code: string;
    decimalPlaces: number;
}

export async function readStoreCurrency(db: Database): Promise<StoreCurrency> {
    const { code, decimalPlaces } = await getCurrencyConfig(db);
    return { code, decimalPlaces };
}

/**
 * Every merchant-entered amount (price, compare-at, fixed discount, delivery
 * charge, threshold, refund, manual adjustment) goes through here: decimal
 * major units to minor units, and in BDT only whole taka ("Taka amounts are
 * whole numbers."). Other currencies keep minor units.
 */
export function toStoreMinor(amount: number, currency: StoreCurrency): number {
    try {
        return toCashMinor(amount, currency.decimalPlaces, currency.code);
    } catch (error) {
        if (error instanceof WholeCashAmountError) throw new ValidationError(error.message);
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
