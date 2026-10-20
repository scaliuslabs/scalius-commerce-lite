// Markets (MARKETS-DESIGN D4): the dashboard aggregate. A market is its row,
// its countries and its presences, written together under one monotonic
// revision. The database keeps the invariants that must never break (one
// backup market, one market per country, the root URL for the backup only,
// no delete of a market with orders); this service turns them into
// merchant-facing errors and keeps the rules: the backup market sells in the
// shop currency at its own price increment; another market sells in the shop
// currency (and uses that increment) or in its own currency (step 6), at its
// exchange rate and its currency's increment; the dashboard creates subfolder
// presences only.
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { handleOrNumberedCopy } from "../../utils/text-match";
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
    MARKET_COUNTRY_SUBFOLDER_PATTERN,
    MAX_MARKET_COUNTRIES,
    MAX_MARKETS,
} from "@scalius/shared/markets";
import { AppError, ConflictError, NotFoundError, ValidationError } from "@scalius/core/errors";
import {
    MARKET_PRICE_ADJUSTMENT_MAX_BPS,
    MARKET_PRICE_ADJUSTMENT_MIN_BPS,
    isMarketPriceMode,
    MANUAL_FX_RATE_SOURCE_ID,
    marketFxPolicyIssue,
    type MarketPriceMode,
} from "@scalius/shared/market-pricing";
import { isQualifiedProviderId } from "@scalius/shared/plugins/providers/kinds";
import { isFxRate } from "@scalius/shared/money-chain";
import { normalizeSupportedCurrencyCode } from "@scalius/shared/currency";
import {
    DEFAULT_FX_LOCK_MINUTES,
    MAX_FX_LOCK_MINUTES,
    MIN_FX_LOCK_MINUTES,
    marketCurrencyIncrementMinor,
} from "@scalius/shared/presentment";
import { readStoreCurrency } from "./pricing";
import { checkoutCopyFollowsDefaultWrites, ensureStoreLanguageWrites } from "../translations";

type SQLiteBatchItem = BatchItem<"sqlite">;

export const MARKET_REVISION_CONFLICT = "market_revision_conflict";

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
    /** The currency it sells in: its own (step 6), else the shop currency. */
    currencyCode: string;
    /** The shop currency (the books' currency, the backup market's). */
    shopCurrencyCode: string;
    /** True when it sells in its own currency, not the shop's. */
    ownCurrency: boolean;
    /**
     * The price increment its prices use: the backup market's own, inherited
     * by every market in the shop currency; a market in its own currency uses
     * that currency's (whole taka for BDT, else the minor unit).
     */
    priceIncrementMinor: number;
    priceIncrementInherited: boolean;
    /** When its manual rate was last set; null without one. */
    fxRateAsOf: Date | null;
    /** How long a placed order keeps its rate, in minutes. */
    fxLockMinutes: number;
    /** Whether its prices include tax (MARKETS-DESIGN D8): checkout and the order's tax snapshot read it. */
    pricesIncludeTax: boolean;
    /**
     * How it prices (MARKETS-DESIGN D5): `fixed` (base prices and its fixed
     * price lists) or `fx` (base prices converted at its rate, adjusted,
     * rounded up to its step and ending). The backup market is always fixed.
     */
    priceMode: MarketPriceMode;
    /** The exchange rate; null: none yet ("1" while it sells the shop currency). */
    fxRate: string | null;
    /**
     * Who sets `fxRate`: `manual` (the merchant) or an app FX provider
     * (`<plugin id>:<provider id>`) whose rate the scheduled tick stores.
     */
    fxRateSource: string;
    /** Percentage adjustment of FX-derived prices, in basis points. */
    priceAdjustmentBps: number;
    /** FX-derived prices round up to this step (minor units); null: the price increment. */
    priceRoundingMinor: number | null;
    /** What a rounded price ends in within its step (minor units); null for none. */
    priceEndingMinor: number | null;
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

/** Which currencies a market may sell in: those an active payment method can charge (the API reads them). */
export interface MarketCurrencyPolicy {
    /** Codes at least one active payment method charges; "any" when one charges every currency. */
    chargeable: readonly string[] | "any";
}

/** How a non-backup market prices (MARKETS-DESIGN D5); amounts in minor units. */
export interface MarketPricingUpdate {
    priceMode?: MarketPriceMode;
    fxRate?: string | null;
    priceAdjustmentBps?: number;
    priceRoundingMinor?: number | null;
    priceEndingMinor?: number | null;
}

export interface MarketUpdate extends MarketPricingUpdate {
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
    /**
     * Non-backup markets (step 6): the currency it sells in; null or the shop
     * currency sells in the shop currency. Another currency needs an exchange
     * rate (`fxRate`) and prices in `fx` mode.
     */
    currencyCode?: string | null;
    /** Minutes a placed order keeps its rate (5 to 1,440). */
    fxLockMinutes?: number;
    /**
     * `manual` or an app FX provider id, for a market in its own currency.
     * The caller checks that the app provides it and sends the app's current
     * rate as `fxRate` in the same update.
     */
    fxRateSource?: string;
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
            ...marketCurrencyFields(row, currency.code, backupIncrement),
            fxRateAsOf: row.fxRateAsOf === null || row.fxRateAsOf === undefined ? null : new Date(Number(row.fxRateAsOf) * 1_000),
            fxLockMinutes: Number(row.fxLockMinutes ?? DEFAULT_FX_LOCK_MINUTES),
            pricesIncludeTax: Boolean(row.pricesIncludeTax),
            priceMode: (row.priceMode === "fx" ? "fx" : "fixed") as MarketPriceMode,
            fxRate: row.fxRate,
            fxRateSource: row.fxRateSource ?? MANUAL_FX_RATE_SOURCE_ID,
            priceAdjustmentBps: row.priceAdjustmentBps,
            priceRoundingMinor: row.priceRoundingMinor,
            priceEndingMinor: row.priceEndingMinor,
            hasOrders: orderRows.some((each) => each.marketId === row.id),
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
        };
    }).map(({ presence, ...record }) => ({
        ...record,
        presence: presence ? { value: presence.value, locale: presence.locale } : null,
    }));
}

/** A market's currency facts: its own currency, else the shop's at the backup increment. */
function marketCurrencyFields(
    row: { isBackup: boolean | number; currencyCode?: string | null; priceIncrementMinor: number | null },
    shopCode: string,
    backupIncrement: number,
) {
    const own = !row.isBackup && row.currencyCode ? row.currencyCode : null;
    const ownCurrency = own !== null && own !== shopCode;
    return {
        currencyCode: ownCurrency ? own! : shopCode,
        shopCurrencyCode: shopCode,
        ownCurrency,
        priceIncrementMinor: row.isBackup
            ? resolvePriceIncrementMinor(shopCode, row.priceIncrementMinor)
            : ownCurrency ? marketCurrencyIncrementMinor(own!) : backupIncrement,
        priceIncrementInherited: !row.isBackup && !ownCurrency,
    };
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
    if (!MARKET_COUNTRY_SUBFOLDER_PATTERN.test(value) || value.slice(0, 2) !== locale) {
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
    if (/STORE_LANGUAGE_REQUIRED/.test(text)) return new ValidationError("Publish the language in Settings → Languages first.");
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
        .where(handleOrNumberedCopy(markets.handle, base));
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
            // The presence's language joins the store's languages (published) when it is new.
            ...(presence ? ensureStoreLanguageWrites(db, [presence.locale]) : []),
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

export async function updateMarket(
    db: Database,
    id: string,
    update: MarketUpdate,
    currencyPolicy: MarketCurrencyPolicy = { chargeable: "any" },
): Promise<MarketUpdateResult> {
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
            throw new ValidationError("Only the backup market sets a price increment. A market in the shop currency uses it; a market in its own currency uses that currency's.");
        }
        if (!isPriceIncrementMinor(current.currencyCode, update.priceIncrementMinor)) {
            throw new ValidationError(`Choose how ${current.currencyCode} prices are entered: ${priceIncrementChoices(current.currencyCode).join(" or ")} minor units.`);
        }
        priceIncrementMinor = update.priceIncrementMinor;
    }

    const currency = cleanCurrency(current, update, currencyPolicy);
    const pricing = cleanPricing(current, update, currency);
    const fxRateSource = cleanFxRateSource(current, update, currency);
    if (update.fxLockMinutes !== undefined) {
        if (current.isBackup) throw new ValidationError("The backup market sells in the shop currency, so it locks no rate.");
        if (!Number.isSafeInteger(update.fxLockMinutes) || update.fxLockMinutes < MIN_FX_LOCK_MINUTES || update.fxLockMinutes > MAX_FX_LOCK_MINUTES) {
            throw new ValidationError(`A rate lock is from ${MIN_FX_LOCK_MINUTES} to ${MAX_FX_LOCK_MINUTES} minutes.`);
        }
    }

    if (update.presence !== undefined) {
        if (current.isBackup) {
            // The root URL stays the backup market's; only its language changes.
            if (!update.presence || update.presence.value !== "") throw new ValidationError("The backup market is sold at the root URL.");
            const locale = update.presence.locale.trim().toLowerCase();
            if (!MARKET_LOCALE_PATTERN.test(locale)) throw new ValidationError("Choose the language of the market's pages.");
            // The root's language is the store's default language: published,
            // and the checkout copy in use follows it.
            if (locale !== current.presence?.locale) {
                writes.push(...ensureStoreLanguageWrites(db, [locale], { publish: true }));
                writes.push(db.update(marketPresences).set({ locale })
                    .where(and(eq(marketPresences.marketId, id), eq(marketPresences.kind, "subfolder"), eq(marketPresences.value, ""))));
                writes.push(...checkoutCopyFollowsDefaultWrites(db, locale));
            }
        } else {
            const presence = update.presence ? cleanPresence(update.presence) : null;
            const unchanged = presence?.value === current.presence?.value && presence?.locale === current.presence?.locale;
            if (!unchanged) {
                await assertPresenceFree(db, presence, id);
                writes.push(db.delete(marketPresences).where(and(eq(marketPresences.marketId, id), eq(marketPresences.kind, "subfolder"))));
                if (presence) {
                    writes.push(...ensureStoreLanguageWrites(db, [presence.locale]));
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
        ...pricing,
        ...(currency.changed ? { currencyCode: currency.own ? currency.code : null } : {}),
        // The rate's as-of time: a new manual rate is set now.
        ...("fxRate" in pricing && pricing.fxRate !== current.fxRate ? { fxRateAsOf: pricing.fxRate === null ? null : sql`unixepoch()` } : {}),
        ...(update.fxLockMinutes === undefined ? {} : { fxLockMinutes: update.fxLockMinutes }),
        ...(fxRateSource === current.fxRateSource ? {} : { fxRateSource }),
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

interface CleanCurrency {
    /** The currency the market will sell in. */
    code: string;
    /** It is not the shop currency. */
    own: boolean;
    changed: boolean;
}

/**
 * The currency a market update sells in (MARKETS-DESIGN step 6). The backup
 * market sells in the shop currency. Another market may sell in its own
 * currency when at least one active payment method can charge it; null or
 * the shop currency sells in the shop currency.
 */
function cleanCurrency(current: MarketRecord, update: MarketUpdate, policy: MarketCurrencyPolicy): CleanCurrency {
    if (update.currencyCode === undefined) {
        return { code: current.currencyCode, own: current.ownCurrency, changed: false };
    }
    const shop = current.shopCurrencyCode;
    const code = update.currencyCode === null ? shop : normalizeSupportedCurrencyCode(update.currencyCode);
    if (!code) throw new ValidationError("Choose a supported currency.");
    if (current.isBackup && code !== shop) {
        throw new ValidationError(`The backup market sells in the shop currency, ${shop}. Change the shop currency in Settings → Store details.`);
    }
    const own = code !== shop;
    if (own && policy.chargeable !== "any" && !policy.chargeable.includes(code)) {
        throw new ValidationError(`No active payment method can charge ${code}. Turn on a payment method that charges ${code}, then choose it.`);
    }
    return { code, own, changed: code !== current.currencyCode };
}

/**
 * The pricing columns a market update writes (only the fields it names, and
 * all of them when its currency changes), checked as a whole against the
 * market's currency and price increment: the backup market sells at base
 * prices; a market in the shop currency converts at "1"; a market in its own
 * currency converts at its rate (`fx` mode; fixed prices go in price lists);
 * a rounding step and an ending are multiples of the increment, the ending
 * inside its step. A new currency drops the old step and ending (they were
 * amounts of the old currency).
 */
function cleanPricing(current: MarketRecord, update: MarketPricingUpdate, currency: CleanCurrency): MarketPricingUpdate {
    const named = (["priceMode", "fxRate", "priceAdjustmentBps", "priceRoundingMinor", "priceEndingMinor"] as const)
        .filter((field) => update[field] !== undefined || (currency.changed && field !== "priceAdjustmentBps"));
    if (named.length === 0) return {};
    if (current.isBackup) {
        throw new ValidationError("The backup market sells at your product prices. Set pricing on your other markets.");
    }
    const keepOrReset = <K extends "priceRoundingMinor" | "priceEndingMinor">(field: K) =>
        update[field] !== undefined ? update[field]! : currency.changed ? null : current[field];
    const next = {
        priceMode: update.priceMode ?? (currency.own ? "fx" as const : current.priceMode),
        fxRate: update.fxRate !== undefined ? update.fxRate?.trim() || null : currency.changed ? null : current.fxRate,
        priceAdjustmentBps: update.priceAdjustmentBps ?? current.priceAdjustmentBps,
        priceRoundingMinor: keepOrReset("priceRoundingMinor"),
        priceEndingMinor: keepOrReset("priceEndingMinor"),
    };
    if (!isMarketPriceMode(next.priceMode)) throw new ValidationError("Choose fixed prices or prices converted at an exchange rate.");
    const shop = current.shopCurrencyCode;
    if (currency.own) {
        if (next.priceMode !== "fx") {
            throw new ValidationError(`This market sells in ${currency.code}, so its prices are your product prices converted at its exchange rate. Fixed ${currency.code} prices go in a price list.`);
        }
        if (next.fxRate === null || !isFxRate(next.fxRate)) {
            throw new ValidationError(`Enter the exchange rate: how many ${currency.code} one ${shop} buys.`);
        }
    } else if (next.fxRate !== null && (!isFxRate(next.fxRate) || Number(next.fxRate) !== 1)) {
        throw new ValidationError(`This market sells in ${shop}, the shop currency, so its exchange rate is 1. Use the price adjustment to raise or lower its prices.`);
    }
    const incrementMinor = currency.own ? marketCurrencyIncrementMinor(currency.code) : current.priceIncrementMinor;
    const issue = marketFxPolicyIssue({
        rate: next.fxRate ?? "1",
        adjustmentBps: next.priceAdjustmentBps,
        roundingMinor: next.priceRoundingMinor,
        endingMinor: next.priceEndingMinor,
    }, incrementMinor);
    if (issue === "adjustment") {
        throw new ValidationError(`A price adjustment is from ${MARKET_PRICE_ADJUSTMENT_MIN_BPS / 100}% to +${MARKET_PRICE_ADJUSTMENT_MAX_BPS / 100}%.`);
    }
    if (issue === "rounding") throw new ValidationError("Round prices to a step that is a whole number of price increments.");
    if (issue === "ending") throw new ValidationError("A price ending needs a rounding step, and is above zero and below the step, in whole price increments.");
    if (issue === "rate") throw new ValidationError(`Enter the exchange rate: how many ${currency.code} one ${shop} buys.`);
    return Object.fromEntries(named.map((field) => [field, next[field]])) as MarketPricingUpdate;
}

/**
 * Who sets the market's rate after this update. Only a market in its own
 * currency takes an app source; a market that goes back to the shop currency
 * goes back to `manual` (its rate is 1).
 */
function cleanFxRateSource(current: MarketRecord, update: MarketUpdate, currency: CleanCurrency): string {
    const requested = update.fxRateSource?.trim();
    if (requested === undefined || requested === current.fxRateSource) return currency.own ? current.fxRateSource : MANUAL_FX_RATE_SOURCE_ID;
    if (requested === MANUAL_FX_RATE_SOURCE_ID) return requested;
    if (!isQualifiedProviderId(requested)) throw new ValidationError("Choose manual rates or an exchange rate app.");
    if (!currency.own) {
        throw new ValidationError(`This market sells in ${current.shopCurrencyCode}, the shop currency, so it needs no exchange rate.`);
    }
    if (update.fxRate === undefined || update.fxRate === null) {
        throw new ValidationError("The exchange rate app has not given a rate yet. Try again.");
    }
    return requested;
}

/** The currencies markets sell in besides the shop currency (a shop currency change waits until none). */
export async function listOwnMarketCurrencies(db: Database): Promise<string[]> {
    const rows = await db.selectDistinct({ code: markets.currencyCode }).from(markets)
        .where(sql`${markets.currencyCode} IS NOT NULL`);
    return rows.flatMap((row) => row.code ? [row.code] : []).sort();
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

/**
 * The writes that turn the backup market into a new store's own country
 * (store setup, onboarding domain): its name and handle, its one country,
 * the root presence's language and the currency's price increment. They join
 * the caller's guarded batch; the revision moves past 1, so the market reads
 * as configured afterwards.
 */
export function backupMarketSetupWrites(db: Database, setup: {
    name: string;
    handle: string;
    countryCode: string;
    locale: string;
    priceIncrementMinor: number;
}): SQLiteBatchItem[] {
    return [
        db.update(markets).set({
            name: cleanName(setup.name),
            handle: cleanHandle(setup.handle),
            priceIncrementMinor: setup.priceIncrementMinor,
            revision: sql`${markets.revision} + 1`,
            updatedAt: sql`unixepoch()`,
        }).where(eq(markets.id, BACKUP_MARKET_ID)),
        ...countryWrites(db, BACKUP_MARKET_ID, cleanCountries([setup.countryCode])),
        // The store's default language: published, with the checkout copy in use following it.
        ...ensureStoreLanguageWrites(db, [setup.locale], { publish: true }),
        db.update(marketPresences).set({ locale: setup.locale })
            .where(and(eq(marketPresences.marketId, BACKUP_MARKET_ID), eq(marketPresences.kind, "subfolder"), eq(marketPresences.value, ""))),
        ...checkoutCopyFollowsDefaultWrites(db, setup.locale),
    ];
}
