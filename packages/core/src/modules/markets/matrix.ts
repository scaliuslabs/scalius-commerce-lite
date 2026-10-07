// The active presence matrix (MARKETS-DESIGN D4): every active market with
// its countries and subfolder presences, backup first, and the backup
// market's price increment. The storefront layout carries it (hreflang, the
// market selector), the gateway resolves a buyer's choice with it, and every
// price reader rounds to its increment. It is one scalar SQL expression, so a
// read adds it to a statement it already runs: a store costs the same D1
// calls and statements with markets as before.
import type { Database } from "@scalius/database/client";
import { marketPresences, markets, settings } from "@scalius/database/schema";
import type { MarketMatrix, PublicMarket } from "@scalius/shared/markets";
import { and, eq, sql, type SQL } from "drizzle-orm";
import { deps } from "../../cache-deps";
import { settingsDocumentsJoin, type SettingsDocumentRow } from "../../settings-store";
import { sellingCountriesFromSql, sellingCountriesSql } from "../../utils/selling-countries";

export interface MarketMatrixRead {
    matrix: MarketMatrix;
    /** The backup market's stored price increment (null without a backup row). */
    backupPriceIncrementMinor: number | null;
}

/**
 * The matrix as one JSON text: an array with one object per active market
 * (`countries` and `presences` are comma lists; a presence is
 * `<value>:<locale>`, the root's value empty), or NULL without an active
 * market. Country codes, subfolder values and locales are letters and dashes
 * only (database checks), so the lists are unambiguous. Every value is cast
 * to text: PostgreSQL's `json_object` takes text. A presence is served only
 * while its language is published (`store_languages`, MARKETS-DESIGN D9; the
 * root's always is). Declares `mk:*`, which language publication advances.
 */
export function marketMatrixSql(): SQL<string | null> {
    deps.anyMarket();
    return sql<string | null>`(SELECT '[' || group_concat(matrix_market.entry, ',') || ']' FROM (
        SELECT json_object(
            'id', matrix_row.id,
            'handle', matrix_row.handle,
            'name', matrix_row.name,
            'isBackup', CAST(matrix_row.is_backup AS TEXT),
            'priceIncrementMinor', CAST(matrix_row.price_increment_minor AS TEXT),
            'countries', (SELECT group_concat(matrix_country.country_code, ',') FROM market_countries AS matrix_country WHERE matrix_country.market_id = matrix_row.id),
            'presences', (SELECT group_concat(matrix_presence.value || ':' || matrix_presence.locale, ',') FROM market_presences AS matrix_presence WHERE matrix_presence.market_id = matrix_row.id AND matrix_presence.kind = 'subfolder'
                AND EXISTS (SELECT 1 FROM store_languages AS matrix_language WHERE matrix_language.locale = matrix_presence.locale AND matrix_language.published = 1))
        ) AS entry
        FROM markets AS matrix_row
        WHERE matrix_row.status = 'active'
    ) AS matrix_market)`;
}

// The countries the active markets sell to (checkout's authority row, the phone
// countries a store accepts): settings and customers read them too, so the
// scalar lives in a shared area both can import.
export { sellingCountriesFromSql, sellingCountriesSql };

interface MatrixEntry {
    id?: unknown;
    handle?: unknown;
    name?: unknown;
    isBackup?: unknown;
    priceIncrementMinor?: unknown;
    countries?: unknown;
    presences?: unknown;
}

function list(value: unknown): string[] {
    return typeof value === "string" && value ? value.split(",").filter(Boolean) : [];
}

function truthy(value: unknown): boolean {
    return value === true || value === 1 || value === "1" || value === "true";
}

function compare(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

/** The matrix of a `marketMatrixSql()` value: the backup market first, the root its first presence. */
export function marketMatrixFromSql(value: unknown): MarketMatrixRead {
    let entries: MatrixEntry[] = [];
    if (typeof value === "string" && value) {
        const parsed = JSON.parse(value) as unknown;
        if (Array.isArray(parsed)) entries = parsed as MatrixEntry[];
    }
    let backupPriceIncrementMinor: number | null = null;
    const all = entries.map((entry): PublicMarket => {
        const isBackup = truthy(entry.isBackup);
        if (isBackup && entry.priceIncrementMinor !== null && entry.priceIncrementMinor !== undefined) {
            const increment = Number(entry.priceIncrementMinor);
            backupPriceIncrementMinor = Number.isFinite(increment) ? increment : null;
        }
        const presences = list(entry.presences)
            .map((item) => {
                const separator = item.lastIndexOf(":");
                return { value: item.slice(0, separator), locale: item.slice(separator + 1) };
            })
            // The root belongs to the backup market alone (the database enforces it too).
            .filter((presence) => isBackup || presence.value !== "")
            .sort((left, right) => (left.value === "" ? -1 : right.value === "" ? 1 : compare(left.value, right.value)));
        return {
            id: String(entry.id),
            handle: String(entry.handle),
            name: String(entry.name),
            isBackup,
            countries: list(entry.countries).sort(),
            presences,
        };
    }).sort((left, right) => Number(right.isBackup) - Number(left.isBackup) || compare(left.name, right.name) || compare(left.id, right.id));
    return { matrix: { markets: all }, backupPriceIncrementMinor };
}

/** The matrix alone, in its own one-row statement (the gateway's choice redirect, the dashboard). */
export async function readMarketMatrix(db: Database): Promise<MarketMatrix> {
    const [row] = await db.select({ matrix: marketMatrixSql() }).from(sql`(SELECT 1 AS one) AS market_matrix_row`);
    return marketMatrixFromSql(row?.matrix).matrix;
}

export interface PresenceMarket {
    id: string;
    handle: string;
    name: string;
    isBackup: boolean;
    presence: { value: string; locale: string };
}

/**
 * The joined presence is served: its language is published (MARKETS-DESIGN
 * D9). The default language is always published, so the root always is.
 */
export function servedLanguageSql(): SQL {
    return sql`EXISTS (SELECT 1 FROM store_languages AS served_language WHERE served_language.locale = ${marketPresences.locale} AND served_language.published = 1)`;
}

/**
 * The active market a market-keyed public read renders for (the one holding
 * the subfolder `value`, or the backup market for the root `''`) and the
 * settings documents the read needs, in ONE statement: the market row joined
 * with the documents. No row: no active market holds that subfolder (the
 * documents are moot). Declares `mk:<id>` for the market (a change of that
 * market or of the presence it holds invalidates the read) and, because the
 * same row carries the countries every active market sells to
 * (`sellingCountries`, for the phone countries a store accepts), `mk:selling`
 * (the set of those countries: a rename of another market leaves the read valid).
 */
export async function readPresenceMarketWithDocuments(
    db: Database,
    value: string,
    documents: readonly { key: string }[],
): Promise<{ market: PresenceMarket | null; documentRows: SettingsDocumentRow[]; sellingCountries: string[] }> {
    const rows = await db.select({
        selling: sellingCountriesSql(),
        id: markets.id,
        handle: markets.handle,
        name: markets.name,
        isBackup: markets.isBackup,
        locale: marketPresences.locale,
        category: settings.category,
        value: settings.value,
        revision: settings.revision,
    })
        .from(markets)
        .leftJoin(marketPresences, and(
            eq(marketPresences.marketId, markets.id),
            eq(marketPresences.kind, "subfolder"),
            eq(marketPresences.value, value),
            // Only a published language's presence is served (MARKETS-DESIGN D9).
            servedLanguageSql(),
        ))
        .leftJoin(settings, settingsDocumentsJoin(documents))
        .where(and(
            eq(markets.status, "active"),
            value === "" ? eq(markets.isBackup, true) : sql`${marketPresences.value} IS NOT NULL`,
        ));
    // Which presences are served: their locales and the published languages.
    if (value !== "") deps.translationLocales();
    const row = rows[0];
    if (!row) return { market: null, documentRows: [], sellingCountries: [] };
    deps.market(row.id);
    return {
        market: {
            id: row.id,
            handle: row.handle,
            name: row.name,
            isBackup: Boolean(row.isBackup),
            presence: { value, locale: row.locale ?? "en" },
        },
        documentRows: rows.flatMap((each) => each.category === null || each.value === null
            ? []
            : [{ category: each.category, value: each.value, revision: each.revision ?? 0 }]),
        sellingCountries: sellingCountriesFromSql(row.selling),
    };
}
