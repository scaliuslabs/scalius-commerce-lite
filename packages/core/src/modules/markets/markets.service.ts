// Markets (MARKETS-DESIGN D4): the dashboard aggregate. A market is its row,
// its countries and its presences, written together under one monotonic
// revision. The database keeps the invariants that must never break (one
// backup market, one market per country, the root URL for the backup only,
// no delete of a market with orders); this service turns them into
// merchant-facing errors and keeps the step-2 rules: every market sells in
// the shop currency, only the backup market has a price increment, and the
// dashboard creates subfolder presences only.
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { nanoid } from "nanoid";
import {
    BACKUP_MARKET_ID,
    marketCountries,
    marketPresences,
    markets,
    orders,
    type MarketStatus,
} from "@scalius/database/schema";
import { buildBatchGuard, isBatchGuardError, safeBatch, type Database } from "@scalius/database/client";
import { isPriceIncrementMinor, priceIncrementChoices, resolvePriceIncrementMinor } from "@scalius/shared/currency-policy";
import { getCountries } from "@scalius/shared/customer-utils";
import { nextFreeHandle, toHandle } from "@scalius/shared/handle";
import {
    MARKET_HANDLE_MAX_LENGTH,
    MARKET_HANDLE_PATTERN,
    MARKET_LOCALE_PATTERN,
    MARKET_NAME_MAX_LENGTH,
    MARKET_SUBFOLDER_PATTERN,
    MAX_MARKET_COUNTRIES,
    MAX_MARKETS,
} from "@scalius/shared/markets";
import { AppError, ConflictError, NotFoundError, ValidationError } from "@scalius/core/errors";
import { readStoreCurrency } from "./pricing";

type SQLiteBatchItem = BatchItem<"sqlite">;

export const MARKET_REVISION_CONFLICT = "MARKET_REVISION_CONFLICT";

export interface MarketPresenceRecord {
    value: string;
    locale: string;
}

/** One market as the dashboard shows and edits it. */
export interface MarketRecord {
    id: string;
    handle: string;
    name: string;
    status: MarketStatus;
    isBackup: boolean;
    revision: number;
    /** ISO 3166-1 alpha-2, sorted. */
    countries: string[];
    /** The root presence (backup) or the market's subfolder; null when it has none. */
    presence: MarketPresenceRecord | null;
    /** Every market sells in the shop currency until step 6. */
    currencyCode: string;
    /** The price increment its prices use: the backup market's own, inherited by every other market. */
    priceIncrementMinor: number;
    priceIncrementInherited: boolean;
    /** Whether its prices include tax (MARKETS-DESIGN D8): checkout and the order's tax snapshot read it. */
    pricesIncludeTax: boolean;
    /** A market that took orders is never deleted; set it to draft instead. */
    hasOrders: boolean;
    createdAt: Date;
    updatedAt: Date;
}

export interface MarketInput {
    name: string;
    /** Derived from the name when omitted. */
    handle?: string;
    status: MarketStatus;
    countries: readonly string[];
    /** A subfolder presence (`en-in` with locale `en`), or null for none. */
    presence: MarketPresenceRecord | null;
    /** Absent: the backup market's. */
    pricesIncludeTax?: boolean;
}

export interface MarketUpdate {
    expectedRevision: number;
    name?: string;
    handle?: string;
    status?: MarketStatus;
    countries?: readonly string[];
    /** Non-backup markets: their subfolder (null removes it). Backup: only the root's locale. */
    presence?: MarketPresenceRecord | null;
    /** Backup market only. */
    priceIncrementMinor?: number;
    pricesIncludeTax?: boolean;
}

const KNOWN_COUNTRIES: ReadonlySet<string> = new Set(getCountries());

// ─────────────────────────────────────────
// Reads
// ─────────────────────────────────────────

async function loadRecords(db: Database, ids?: readonly string[]): Promise<MarketRecord[]> {
    const where = ids ? inArray(markets.id, [...ids]) : undefined;
    const [marketRows, countryRows, presenceRows, orderRows, currency] = await Promise.all([
        db.select().from(markets).where(where).orderBy(sql`${markets.isBackup} DESC`, asc(markets.name), asc(markets.id)),
        db.select({ countryCode: marketCountries.countryCode, marketId: marketCountries.marketId })
            .from(marketCountries)
            .where(ids ? inArray(marketCountries.marketId, [...ids]) : undefined)
            .orderBy(asc(marketCountries.countryCode)),
        db.select({ marketId: marketPresences.marketId, value: marketPresences.value, locale: marketPresences.locale })
            .from(marketPresences)
            .where(and(eq(marketPresences.kind, "subfolder"), ids ? inArray(marketPresences.marketId, [...ids]) : undefined))
            .orderBy(asc(marketPresences.createdAt), asc(marketPresences.value)),
        // One indexed probe per market (orders_market_idx).
        db.select({ marketId: sql<string>`market_with_orders.id` })
            .from(sql`${markets} AS market_with_orders`)
            .where(sql`EXISTS (SELECT 1 FROM ${orders} AS market_order WHERE market_order.market_id = market_with_orders.id)`),
        readStoreCurrency(db),
    ]);
    const backupIncrement = currency.priceIncrementMinor;
    return marketRows.map((row) => {
        const presences = presenceRows.filter((presence) => presence.marketId === row.id);
        return {
            id: row.id,
            handle: row.handle,
            name: row.name,
            status: row.status as MarketStatus,
            isBackup: Boolean(row.isBackup),
            revision: row.revision,
            countries: countryRows.filter((country) => country.marketId === row.id).map((country) => country.countryCode),
            presence: (row.isBackup ? presences.find((each) => each.value === "") : presences.find((each) => each.value !== "")) ?? null,
            currencyCode: currency.code,
            priceIncrementMinor: row.isBackup ? resolvePriceIncrementMinor(currency.code, row.priceIncrementMinor) : backupIncrement,
            priceIncrementInherited: !row.isBackup,
            pricesIncludeTax: Boolean(row.pricesIncludeTax),
            hasOrders: orderRows.some((each) => each.marketId === row.id),
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
        };
    }).map(({ presence, ...record }) => ({
        ...record,
        presence: presence ? { value: presence.value, locale: presence.locale } : null,
    }));
}

export async function listMarkets(db: Database): Promise<MarketRecord[]> {
    return loadRecords(db);
}

export async function getMarket(db: Database, id: string): Promise<MarketRecord> {
    const [record] = await loadRecords(db, [id]);
    if (!record) throw new NotFoundError("Market not found");
    return record;
}

// ─────────────────────────────────────────
// Validation
// ─────────────────────────────────────────

function cleanName(name: string): string {
    const trimmed = name.trim();
    if (!trimmed) throw new ValidationError("Give the market a name.");
    if (trimmed.length > MARKET_NAME_MAX_LENGTH) throw new ValidationError(`A market name is at most ${MARKET_NAME_MAX_LENGTH} characters.`);
    return trimmed;
}

function cleanHandle(handle: string): string {
    const trimmed = handle.trim();
    if (!MARKET_HANDLE_PATTERN.test(trimmed) || trimmed.length > MARKET_HANDLE_MAX_LENGTH) {
        throw new ValidationError("A market handle uses lowercase letters, digits and single dashes, at most 60 characters.");
    }
    return trimmed;
}

function cleanCountries(countries: readonly string[]): string[] {
    const codes = [...new Set(countries.map((country) => country.trim().toUpperCase()))].sort();
    if (codes.length > MAX_MARKET_COUNTRIES) throw new ValidationError(`A market has at most ${MAX_MARKET_COUNTRIES} countries.`);
    const unknown = codes.filter((code) => !KNOWN_COUNTRIES.has(code));
    if (unknown.length > 0) throw new ValidationError(`Unknown country codes: ${unknown.join(", ")}.`);
    return codes;
}

function cleanPresence(presence: MarketPresenceRecord): MarketPresenceRecord {
    const value = presence.value.trim().toLowerCase();
    const locale = presence.locale.trim().toLowerCase();
    if (!MARKET_LOCALE_PATTERN.test(locale)) throw new ValidationError("Choose the language of the market's pages.");
    if (!MARKET_SUBFOLDER_PATTERN.test(value) || value.slice(0, 2) !== locale) {
        throw new ValidationError(`A subfolder is the language and the country, such as ${locale}-in.`);
    }
    return { value, locale };
}

/** Countries another market sells to, with that market's name. */
async function takenCountries(db: Database, countries: readonly string[], marketId: string | null) {
    if (countries.length === 0) return [];
    return db.select({ countryCode: marketCountries.countryCode, name: markets.name })
        .from(marketCountries)
        .innerJoin(markets, eq(markets.id, marketCountries.marketId))
        .where(and(
            sql`${marketCountries.countryCode} IN (SELECT value FROM json_each(${JSON.stringify(countries)}))`,
            marketId ? ne(marketCountries.marketId, marketId) : undefined,
        ));
}

async function assertCountriesFree(db: Database, countries: readonly string[], marketId: string | null): Promise<void> {
    const taken = await takenCountries(db, countries, marketId);
    if (taken.length > 0) {
        throw new ConflictError(`Each country belongs to one market. Remove ${taken.map((row) => `${row.countryCode} from ${row.name}`).join(", ")} first.`);
    }
}

async function assertPresenceFree(db: Database, presence: MarketPresenceRecord | null, marketId: string | null): Promise<void> {
    if (!presence) return;
    const owner = await db.select({ name: markets.name })
        .from(marketPresences)
        .innerJoin(markets, eq(markets.id, marketPresences.marketId))
        .where(and(
            eq(marketPresences.kind, "subfolder"),
            eq(marketPresences.value, presence.value),
            marketId ? ne(marketPresences.marketId, marketId) : undefined,
        ))
        .get();
    if (owner) throw new ConflictError(`/${presence.value} is ${owner.name}'s subfolder. Choose another.`);
}

function collectErrorText(error: unknown, depth = 0): string {
    if (depth > 5 || error === null || error === undefined) return "";
    if (typeof error !== "object") return String(error);
    const candidate = error as { message?: unknown; detail?: unknown; cause?: unknown };
    return [candidate.message, candidate.detail, collectErrorText(candidate.cause, depth + 1)]
        .filter((value): value is string => typeof value === "string" && value.length > 0)
        .join(" ");
}

/** Database refusals a concurrent writer can still cause, as merchant-facing errors. */
function marketWriteError(error: unknown): unknown {
    if (error instanceof AppError) return error;
    if (isBatchGuardError(error, MARKET_REVISION_CONFLICT)) {
        return new ConflictError("This market changed in another session. Reload it, then save again.");
    }
    const text = collectErrorText(error);
    if (/markets_handle_unique|markets\.handle|lower\(trim\("?handle/i.test(text)) return new ConflictError("Another market uses this handle.");
    if (/market_countries/i.test(text) && /UNIQUE|PRIMARY|duplicate/i.test(text)) return new ConflictError("Each country belongs to one market. Another market took one of these countries.");
    if (/market_presences/i.test(text) && /UNIQUE|duplicate/i.test(text)) return new ConflictError("Another market uses this subfolder.");
    if (/FOREIGN KEY|foreign key/i.test(text)) return new ConflictError("This market has orders, so it can't be deleted. Set it to draft instead.");
    if (/MARKET_BACKUP_REQUIRED/.test(text)) return new ValidationError("The backup market can't be deleted or replaced.");
    if (/MARKET_ROOT_PRESENCE_BACKUP_ONLY/.test(text)) return new ValidationError("Only the backup market is sold at the root URL.");
    return error;
}

// ─────────────────────────────────────────
// Writes
// ─────────────────────────────────────────

function revisionGuard(db: Database, id: string, expectedRevision: number): SQLiteBatchItem {
    return buildBatchGuard(
        db,
        sql`EXISTS (SELECT 1 FROM ${markets} WHERE ${markets.id} = ${id} AND ${markets.revision} = ${expectedRevision})`,
        MARKET_REVISION_CONFLICT,
    );
}

function countryWrites(db: Database, id: string, countries: readonly string[]): SQLiteBatchItem[] {
    const list = JSON.stringify(countries);
    return [
        db.delete(marketCountries).where(and(
            eq(marketCountries.marketId, id),
            sql`${marketCountries.countryCode} NOT IN (SELECT value FROM json_each(${list}))`,
        )),
        // A country another market holds fails the batch on the primary key.
        db.insert(marketCountries).select(
            db.select({
                countryCode: sql<string>`value`.as("country_code"),
                marketId: sql<string>`${id}`.as("market_id"),
                createdAt: sql<Date>`unixepoch()`.as("created_at"),
            }).from(sql`json_each(${list})`)
                .where(sql`value NOT IN (SELECT ${marketCountries.countryCode} FROM ${marketCountries} WHERE ${marketCountries.marketId} = ${id})`),
        ) as unknown as SQLiteBatchItem,
    ];
}

async function derivedHandle(db: Database, name: string): Promise<string> {
    const base = (toHandle(name) || "market").slice(0, MARKET_HANDLE_MAX_LENGTH).replace(/-+$/, "") || "market";
    const rows = await db.select({ handle: markets.handle }).from(markets)
        .where(sql`${markets.handle} = ${base} OR ${markets.handle} LIKE ${`${base}-%`}`);
    return nextFreeHandle(base, rows.map((row) => row.handle));
}

export async function createMarket(db: Database, input: MarketInput): Promise<MarketRecord> {
    const name = cleanName(input.name);
    const countries = cleanCountries(input.countries);
    if (countries.length === 0) throw new ValidationError("Add at least one country to the market.");
    const presence = input.presence ? cleanPresence(input.presence) : null;
    const [count] = await db.select({ n: sql<number>`count(*)` }).from(markets);
    if (Number(count?.n ?? 0) >= MAX_MARKETS) throw new ValidationError(`A store has at most ${MAX_MARKETS} markets.`);
    await Promise.all([assertCountriesFree(db, countries, null), assertPresenceFree(db, presence, null)]);
    const handle = input.handle ? cleanHandle(input.handle) : await derivedHandle(db, name);
    const id = `mkt_${nanoid(16)}`;
    // A new market prices like the backup market until the merchant says otherwise.
    const pricesIncludeTax = input.pricesIncludeTax === undefined
        ? sql`coalesce((SELECT backup_market.prices_include_tax FROM markets AS backup_market WHERE backup_market.is_backup = 1), 0)`
        : input.pricesIncludeTax;
    try {
        await safeBatch(db, [
            db.insert(markets).values({ id, handle, name, status: input.status, isBackup: false, priceIncrementMinor: null, pricesIncludeTax, revision: 1 }),
            ...countryWrites(db, id, countries),
            ...(presence ? [db.insert(marketPresences).values({ id: `mkp_${nanoid(16)}`, marketId: id, kind: "subfolder", ...presence })] : []),
        ] as never);
    } catch (error) {
        throw marketWriteError(error);
    }
    return getMarket(db, id);
}

export interface MarketUpdateResult {
    market: MarketRecord;
    /** The backup market's effective increment changed: catalogue projections need a rebuild. */
    priceIncrementChanged: boolean;
}

export async function updateMarket(db: Database, id: string, update: MarketUpdate): Promise<MarketUpdateResult> {
    const current = await getMarket(db, id);
    if (current.revision !== update.expectedRevision) {
        throw new ConflictError("This market changed in another session. Reload it, then save again.");
    }
    const name = update.name === undefined ? current.name : cleanName(update.name);
    const handle = update.handle === undefined ? current.handle : cleanHandle(update.handle);
    const status = update.status ?? current.status;
    if (current.isBackup && status !== "active") throw new ValidationError("The backup market is always active.");
    const countries = update.countries === undefined ? current.countries : cleanCountries(update.countries);
    if (!current.isBackup && countries.length === 0) throw new ValidationError("Add at least one country to the market.");

    const writes: SQLiteBatchItem[] = [revisionGuard(db, id, update.expectedRevision)];
    let priceIncrementMinor: number | null = null;
    if (update.priceIncrementMinor !== undefined) {
        if (!current.isBackup) {
            throw new ValidationError("Markets sell in the shop currency, so they use the backup market's price increment.");
        }
        if (!isPriceIncrementMinor(current.currencyCode, update.priceIncrementMinor)) {
            throw new ValidationError(`Choose how ${current.currencyCode} prices are entered: ${priceIncrementChoices(current.currencyCode).join(" or ")} minor units.`);
        }
        priceIncrementMinor = update.priceIncrementMinor;
    }

    if (update.presence !== undefined) {
        if (current.isBackup) {
            // The root URL stays the backup market's; only its language changes.
            if (!update.presence || update.presence.value !== "") throw new ValidationError("The backup market is sold at the root URL.");
            const locale = update.presence.locale.trim().toLowerCase();
            if (!MARKET_LOCALE_PATTERN.test(locale)) throw new ValidationError("Choose the language of the market's pages.");
            writes.push(db.update(marketPresences).set({ locale })
                .where(and(eq(marketPresences.marketId, id), eq(marketPresences.kind, "subfolder"), eq(marketPresences.value, ""))));
        } else {
            const presence = update.presence ? cleanPresence(update.presence) : null;
            const unchanged = presence?.value === current.presence?.value && presence?.locale === current.presence?.locale;
            if (!unchanged) {
                await assertPresenceFree(db, presence, id);
                writes.push(db.delete(marketPresences).where(and(eq(marketPresences.marketId, id), eq(marketPresences.kind, "subfolder"))));
                if (presence) {
                    writes.push(db.insert(marketPresences).values({ id: `mkp_${nanoid(16)}`, marketId: id, kind: "subfolder", ...presence }));
                }
            }
        }
    }
    if (update.countries !== undefined) {
        await assertCountriesFree(db, countries, id);
        writes.push(...countryWrites(db, id, countries));
    }
    writes.splice(1, 0, db.update(markets).set({
        name,
        handle,
        status,
        ...(priceIncrementMinor === null ? {} : { priceIncrementMinor }),
        ...(update.pricesIncludeTax === undefined ? {} : { pricesIncludeTax: update.pricesIncludeTax }),
        revision: sql`${markets.revision} + 1`,
        updatedAt: sql`unixepoch()`,
    }).where(eq(markets.id, id)));
    try {
        await safeBatch(db, writes as never);
    } catch (error) {
        throw marketWriteError(error);
    }
    const market = await getMarket(db, id);
    return { market, priceIncrementChanged: market.isBackup && market.priceIncrementMinor !== current.priceIncrementMinor };
}

export async function deleteMarket(db: Database, id: string, expectedRevision: number): Promise<void> {
    const current = await getMarket(db, id);
    if (current.isBackup) throw new ValidationError("The backup market can't be deleted.");
    if (current.hasOrders) throw new ConflictError("This market has orders, so it can't be deleted. Set it to draft instead.");
    try {
        await safeBatch(db, [
            revisionGuard(db, id, expectedRevision),
            db.delete(markets).where(and(eq(markets.id, id), eq(markets.isBackup, false))),
        ] as never);
    } catch (error) {
        throw marketWriteError(error);
    }
}

/**
 * A new shop currency (Settings → Store details) prices at its own default
 * increment: the backup market's choice was made for the old currency.
 * Returns whether the effective increment changed.
 */
export async function resetBackupPriceIncrement(db: Database, currencyCode: string, previousIncrementMinor: number): Promise<boolean> {
    const choices = priceIncrementChoices(currencyCode);
    const next = resolvePriceIncrementMinor(currencyCode, undefined);
    if (!choices.includes(next)) return false;
    await db.update(markets)
        .set({ priceIncrementMinor: next, revision: sql`${markets.revision} + 1`, updatedAt: sql`unixepoch()` })
        .where(and(eq(markets.id, BACKUP_MARKET_ID), sql`${markets.priceIncrementMinor} IS NOT ${next}`));
    return next !== previousIncrementMinor;
}
