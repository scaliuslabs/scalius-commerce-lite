import type { Database } from "@scalius/database/client";
import { settings } from "@scalius/database/schema";
import {
    DEFAULT_CURRENCY,
    getDecimalPlaces,
    normalizeSupportedCurrencyCode,
    SUPPORTED_CURRENCY_CODES,
} from "@scalius/shared/currency";
import {
    defaultPriceIncrementMinor,
    type PricingCurrency,
    resolvePriceIncrementMinor,
} from "@scalius/shared/currency-policy";
import { PriceIncrementError, toIncrementMinor } from "@scalius/shared/money";
import { sql, type SQL } from "drizzle-orm";
import { ValidationError } from "@scalius/core/errors";
import { deps } from "../../cache-deps";
import { currencyDocument } from "./documents";
import { getCurrencyConfig } from "./settings.service";
import { SETTINGS_DOCUMENT_ROW_KEY } from "../../settings-store";

/**
 * The store currency as money writes need it; `priceIncrementMinor` is the
 * default market's price increment (`priceIncrementOf`): merchant amounts are
 * multiples of it, derived amounts round to it.
 */
export type StoreCurrency = PricingCurrency;

export async function readStoreCurrency(db: Database): Promise<StoreCurrency> {
    const { code, decimalPlaces, priceIncrementMinor } = await getCurrencyConfig(db);
    return { code, decimalPlaces, priceIncrementMinor };
}

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

const quoted = (codes: readonly string[]) => codes.map((code) => `'${code}'`).join(", ");
// Supported codes are fixed ISO literals, so they are inlined rather than bound.
const SUPPORTED_CODES_SQL = quoted(SUPPORTED_CURRENCY_CODES);
/** Whole-unit increments above 1 and the codes they belong to, e.g. 100 → every two-decimal code. */
const WHOLE_UNIT_INCREMENTS = [...new Set(SUPPORTED_CURRENCY_CODES.map((code) => 10 ** getDecimalPlaces(code)))]
    .filter((increment) => increment > 1)
    .sort((left, right) => left - right)
    .map((increment) => ({
        increment,
        codes: quoted(SUPPORTED_CURRENCY_CODES.filter((code) => 10 ** getDecimalPlaces(code) === increment)),
    }));
/** Codes whose default increment is above 1 (BDT: whole taka), by increment. */
const DEFAULT_INCREMENT_GROUPS = [...new Set(SUPPORTED_CURRENCY_CODES.map(defaultPriceIncrementMinor))]
    .filter((increment) => increment > 1)
    .map((increment) => ({
        increment,
        codes: quoted(SUPPORTED_CURRENCY_CODES.filter((code) => defaultPriceIncrementMinor(code) === increment)),
    }));
const DEFAULT_PRICE_INCREMENT = defaultPriceIncrementMinor(DEFAULT_CURRENCY.code);

/** Every value `storePriceIncrementSql` can yield, smallest first. */
export const STORE_PRICE_INCREMENTS: readonly number[] = [1, ...WHOLE_UNIT_INCREMENTS.map(({ increment }) => increment)];

/**
 * The store's price increment as one scalar subquery, mirroring
 * `priceIncrementOf(currencyDocument)`: a saved choice valid for the saved
 * code, else the code's default; a missing row or unsupported code is the
 * default currency's (whole taka). Its constants are inlined, so it binds no
 * parameters (catalog reads repeat price expressions; D1 allows 100).
 */
export function storePriceIncrementSql(): SQL<number> {
    deps.settings(currencyDocument.key, SETTINGS_DOCUMENT_ROW_KEY);
    const field = (path: string) => sql`CASE WHEN json_valid(${settings.value}) THEN json_extract(${settings.value}, ${sql.raw(`'${path}'`)}) END`;
    const code = sql`upper(trim(coalesce(${field("$.currencyCode")}, '')))`;
    // Only a JSON integer is an increment (a string "1" is not, as in TypeScript).
    const saved = sql`CASE WHEN json_valid(${settings.value}) THEN CASE
        WHEN json_type(${settings.value}, '$.priceIncrementMinor') = 'integer'
            THEN CAST(json_extract(${settings.value}, '$.priceIncrementMinor') AS TEXT)
    END END`;
    const wholeUnits = WHOLE_UNIT_INCREMENTS.map(({ increment, codes }) =>
        sql` WHEN ${saved} = ${sql.raw(`'${increment}'`)} AND ${code} IN (${sql.raw(codes)}) THEN ${sql.raw(String(increment))}`);
    const defaults = DEFAULT_INCREMENT_GROUPS.map(({ increment, codes }) =>
        sql` WHEN ${code} IN (${sql.raw(codes)}) THEN ${sql.raw(String(increment))}`);
    return sql<number>`coalesce((
        SELECT CASE
            WHEN ${code} NOT IN (${sql.raw(SUPPORTED_CODES_SQL)}) THEN ${sql.raw(String(DEFAULT_PRICE_INCREMENT))}
            WHEN ${saved} = '1' THEN 1${sql.join(wholeUnits, sql.raw(""))}${sql.join(defaults, sql.raw(""))}
            ELSE 1
        END
        FROM ${settings}
        WHERE ${settings.category} = ${sql.raw(`'${currencyDocument.key}'`)} AND ${settings.key} = ${sql.raw(`'${SETTINGS_DOCUMENT_ROW_KEY}'`)}
    ), ${sql.raw(String(DEFAULT_PRICE_INCREMENT))})`;
}

/** The store currency of a row that selected `storeCurrencyCodeSql()` and `storePriceIncrementSql()`. */
export function storeCurrencyFromSql(code: unknown, priceIncrementMinor: unknown): StoreCurrency {
    const currency = storeCurrencyFromCode(code);
    return {
        code: currency,
        decimalPlaces: getDecimalPlaces(currency),
        priceIncrementMinor: resolvePriceIncrementMinor(currency, Number(priceIncrementMinor)),
    };
}

/** Mirrors `currencyDocument`: a missing or unsupported code means the default currency. */
export function storeCurrencyFromCode(code: unknown): string {
    return normalizeSupportedCurrencyCode(code) ?? DEFAULT_CURRENCY.code;
}

export function storeDecimalPlacesFromCode(code: unknown): number {
    return getDecimalPlaces(storeCurrencyFromCode(code));
}
