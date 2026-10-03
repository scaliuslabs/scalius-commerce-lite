// The store's pricing currency (MARKETS-DESIGN D1, D4): the shop currency (a
// store fact, the `currency` settings document) priced at the backup
// market's price increment (`markets.price_increment_minor`, the one source).
// Every other market sells in the shop currency until step 6, so this is the
// pricing currency of every market today.
import type { Database } from "@scalius/database/client";
import { BACKUP_MARKET_ID, markets, settings } from "@scalius/database/schema";
import {
    DEFAULT_CURRENCY,
    getDecimalPlaces,
    SUPPORTED_CURRENCY_CODES,
} from "@scalius/shared/currency";
import { defaultPriceIncrementMinor, resolvePriceIncrementMinor } from "@scalius/shared/currency-policy";
import { eq, sql, type SQL } from "drizzle-orm";
import { deps } from "../../cache-deps";
import { currencyDocument, storeCurrencyFromCode, type CurrencySettings, type StoreCurrency } from "../settings";
import { SETTINGS_DOCUMENT_ROW_KEY, settingsDocumentsJoin } from "../../settings-store";

/**
 * The backup market's stored price increment as a scalar, for a statement a
 * read already runs (so pricing costs no extra statement). Declares
 * `mk:backup`, which only a change of that increment advances.
 */
export function backupPriceIncrementSql(): SQL<number | null> {
    deps.backupMarketPricing();
    return sql<number | null>`(SELECT backup_increment.price_increment_minor FROM markets AS backup_increment WHERE backup_increment.is_backup = 1)`;
}

/** The store currency from the currency document and the backup market's stored increment. */
export function storeCurrencyOf(
    currency: Pick<CurrencySettings, "currencyCode">,
    storedPriceIncrementMinor: unknown,
): StoreCurrency {
    return {
        code: currency.currencyCode,
        decimalPlaces: getDecimalPlaces(currency.currencyCode),
        priceIncrementMinor: resolvePriceIncrementMinor(currency.currencyCode, storedPriceIncrementMinor),
    };
}

/**
 * The store currency in one statement, as before markets: the currency
 * document joined beside the backup market's increment.
 */
export async function readStoreCurrency(db: Database): Promise<StoreCurrency & { symbol: string }> {
    const rows = await db.select({
        backupPriceIncrementMinor: backupPriceIncrementSql(),
        category: settings.category,
        value: settings.value,
        revision: settings.revision,
    })
        .from(sql`(SELECT 1 AS one) AS store_currency_row`)
        .leftJoin(settings, settingsDocumentsJoin([currencyDocument]));
    const list = Array.isArray(rows) ? rows : [];
    const currency = (await currencyDocument.fromRows(list.flatMap((row) => row.category === null || row.value === null
        ? []
        : [{ category: row.category, value: row.value, revision: row.revision ?? 0 }]))).value;
    // No backup row (a store before 0112) reads as the currency's default increment.
    return { ...storeCurrencyOf(currency, list[0]?.backupPriceIncrementMinor), symbol: currency.currencySymbol };
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
 * `readStoreCurrency`: the backup market's stored increment when it is a
 * choice for the shop currency, else that currency's default; a missing or
 * unsupported currency code is the default currency (BDT, whole taka). Its
 * constants are inlined, so it binds no parameters (catalog reads repeat
 * price expressions; D1 allows 100). It declares `mk:backup` (only a change
 * of that increment advances it) and the currency document.
 */
export function storePriceIncrementSql(): SQL<number> {
    deps.settings(currencyDocument.key, SETTINGS_DOCUMENT_ROW_KEY);
    deps.backupMarketPricing();
    const document = sql`(SELECT CASE WHEN json_valid(${settings.value}) THEN json_extract(${settings.value}, '$.currencyCode') END
        FROM ${settings}
        WHERE ${settings.category} = ${sql.raw(`'${currencyDocument.key}'`)} AND ${settings.key} = ${sql.raw(`'${SETTINGS_DOCUMENT_ROW_KEY}'`)})`;
    const raw = sql`upper(trim(coalesce(${document}, '')))`;
    const code = sql`CASE WHEN ${raw} IN (${sql.raw(SUPPORTED_CODES_SQL)}) THEN ${raw} ELSE ${sql.raw(`'${DEFAULT_CURRENCY.code}'`)} END`;
    const stored = sql`backup_market.price_increment_minor`;
    const wholeUnits = WHOLE_UNIT_INCREMENTS.map(({ increment, codes }) =>
        sql` WHEN ${stored} = ${sql.raw(String(increment))} AND store_currency.code IN (${sql.raw(codes)}) THEN ${sql.raw(String(increment))}`);
    const defaults = DEFAULT_INCREMENT_GROUPS.map(({ increment, codes }) =>
        sql` WHEN store_currency.code IN (${sql.raw(codes)}) THEN ${sql.raw(String(increment))}`);
    return sql<number>`coalesce((
        SELECT CASE
            WHEN ${stored} = 1 THEN 1${sql.join(wholeUnits, sql.raw(""))}${sql.join(defaults, sql.raw(""))}
            ELSE 1
        END
        FROM (SELECT ${code} AS code) AS store_currency
        LEFT JOIN ${markets} AS backup_market ON backup_market.is_backup = 1
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

/** The backup market's id: fixed by migration 0112 (it can never be removed). */
export { BACKUP_MARKET_ID };
