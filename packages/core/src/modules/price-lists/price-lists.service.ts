// Price lists (MARKETS-DESIGN D5): the dashboard aggregate. A list is its row
// and its prices, written under one monotonic revision. The database keeps
// the invariants that must never break (market and sale lists off the backup
// market, a segment for every segment list, positive prices, compare-at above
// the amount, one row per SKU, currency and quantity break); this service
// turns them into merchant-facing errors, keeps the limits and enters every
// price at the market's price increment.
import { and, asc, eq, sql } from "drizzle-orm";
import { containsText } from "../../utils/text-match";
import type { BatchItem } from "drizzle-orm/batch";
import { nanoid } from "nanoid";
import {
    customerSegments,
    markets,
    priceListPrices,
    priceLists,
    productVariants,
    products,
} from "@scalius/database/schema";
import { buildBatchGuard, isBatchGuardError, safeBatch, type Database } from "@scalius/database/client";
import {
    MAX_PRICE_LIST_PRICES,
    MAX_PRICE_LIST_QUANTITY_BREAKS,
    MAX_PRICE_LISTS,
    PRICE_LIST_DESCRIPTION_MAX_LENGTH,
    PRICE_LIST_MIN_QUANTITY_MAX,
    PRICE_LIST_NAME_MAX_LENGTH,
    PRICE_LIST_PRIORITY_MAX,
    isPriceListKind,
    type PriceListKind,
    type PriceListStatus,
} from "@scalius/shared/market-pricing";
import { PriceIncrementError, fromMinor, toIncrementMinor } from "@scalius/shared/money";
import { AppError, ConflictError, NotFoundError, ValidationError } from "@scalius/core/errors";
import { readStoreCurrency } from "../markets";
import { variantOptionLabelSql } from "../products";
import { marketCurrencyIncrementMinor } from "@scalius/shared/presentment";
import { getDecimalPlaces } from "@scalius/shared/currency";

type SQLiteBatchItem = BatchItem<"sqlite">;

export const PRICE_LIST_REVISION_CONFLICT = "price_list_revision_conflict";

/** What a list does now: its status read with its schedule. */
export type PriceListState = "draft" | "scheduled" | "active" | "expired";

export interface PriceListRecord {
    id: string;
    name: string;
    description: string | null;
    kind: PriceListKind;
    marketId: string;
    marketName: string;
    marketIsBackup: boolean;
    segmentId: string | null;
    segmentName: string | null;
    status: PriceListStatus;
    state: PriceListState;
    startsAt: Date | null;
    endsAt: Date | null;
    priority: number;
    revision: number;
    /** Price rows (quantity breaks included) and the SKUs they price. */
    priceCount: number;
    variantCount: number;
    /** The market's currency: every price of the list is in it. */
    currencyCode: string;
    priceIncrementMinor: number;
    createdAt: Date;
    updatedAt: Date;
}

export interface PriceListInput {
    name: string;
    description?: string | null;
    kind: PriceListKind;
    marketId: string;
    /** Segment lists only. */
    segmentId?: string | null;
    status?: PriceListStatus;
    startsAt?: Date | null;
    endsAt?: Date | null;
    priority?: number;
}

export interface PriceListUpdate extends Partial<Omit<PriceListInput, "kind">> {
    expectedRevision: number;
    kind?: PriceListKind;
}

/** One SKU of a list in the editor: its product, label, base price and its tiers. */
export interface PriceListVariantPrices {
    variantId: string;
    productId: string;
    productName: string;
    variantLabel: string | null;
    sku: string;
    /** The SKU's own price (shop currency minor units). */
    basePriceMinor: number;
    prices: Array<{ currencyCode: string; amountMinor: number; compareAtMinor: number | null; minQuantity: number }>;
}

/** Decimal major units, as the HTTP contract sends them. */
export interface PriceTierInput {
    amount: number;
    compareAt?: number | null;
    /** Default 1 (the list's price); larger values are quantity breaks. */
    minQuantity?: number;
}

export interface PriceListPricesUpdate {
    expectedRevision: number;
    /** Each SKU's full set of tiers in the market currency (replaces what it had). */
    set?: ReadonlyArray<{ variantId: string; prices: readonly PriceTierInput[] }>;
    /** SKUs to take out of the list. */
    remove?: readonly string[];
}

/** SKUs one price write may touch. */
export const PRICE_LIST_WRITE_MAX_VARIANTS = 100;

function stateOf(status: PriceListStatus, startsAt: Date | null, endsAt: Date | null, now = Date.now()): PriceListState {
    if (status !== "active") return "draft";
    if (startsAt && startsAt.getTime() > now) return "scheduled";
    if (endsAt && endsAt.getTime() <= now) return "expired";
    return "active";
}

// ─────────────────────────────────────────
// Reads
// ─────────────────────────────────────────

const priceCountSql = sql<number>`CAST((SELECT count(*) FROM price_list_prices AS counted_price WHERE counted_price.price_list_id = "price_lists"."id") AS INTEGER)`;
const variantCountSql = sql<number>`CAST((SELECT count(DISTINCT counted_variant.variant_id) FROM price_list_prices AS counted_variant WHERE counted_variant.price_list_id = "price_lists"."id") AS INTEGER)`;

async function loadRecords(db: Database, filter: { id?: string; marketId?: string } = {}): Promise<PriceListRecord[]> {
    const [rows, currency] = await Promise.all([
        db.select({
            list: priceLists,
            marketName: markets.name,
            marketIsBackup: markets.isBackup,
            marketCurrencyCode: markets.currencyCode,
            segmentName: customerSegments.name,
            priceCount: priceCountSql,
            variantCount: variantCountSql,
        })
            .from(priceLists)
            .innerJoin(markets, eq(markets.id, priceLists.marketId))
            .leftJoin(customerSegments, eq(customerSegments.id, priceLists.segmentId))
            .where(and(
                filter.id ? eq(priceLists.id, filter.id) : undefined,
                filter.marketId ? eq(priceLists.marketId, filter.marketId) : undefined,
            ))
            .orderBy(asc(priceLists.name), asc(priceLists.id)),
        readStoreCurrency(db),
    ]);
    return rows.map(({ list, marketName, marketIsBackup, marketCurrencyCode, segmentName, priceCount, variantCount }) => {
        // A market in its own currency (MARKETS-DESIGN step 6) takes its list prices in it.
        const own = !marketIsBackup && marketCurrencyCode && marketCurrencyCode !== currency.code ? marketCurrencyCode : null;
        return {
            id: list.id,
            name: list.name,
            description: list.description,
            kind: list.kind as PriceListKind,
            marketId: list.marketId,
            marketName,
            marketIsBackup: Boolean(marketIsBackup),
            segmentId: list.segmentId,
            segmentName: segmentName ?? null,
            status: list.status as PriceListStatus,
            state: stateOf(list.status as PriceListStatus, list.startsAt, list.endsAt),
            startsAt: list.startsAt,
            endsAt: list.endsAt,
            priority: list.priority,
            revision: list.revision,
            priceCount: Number(priceCount),
            variantCount: Number(variantCount),
            currencyCode: own ?? currency.code,
            priceIncrementMinor: own ? marketCurrencyIncrementMinor(own) : currency.priceIncrementMinor,
            createdAt: list.createdAt,
            updatedAt: list.updatedAt,
        };
    });
}

/** Every price list (a store keeps at most `MAX_PRICE_LISTS`), by name; optionally one market's. */
export async function listPriceLists(db: Database, filter: { marketId?: string } = {}): Promise<PriceListRecord[]> {
    return loadRecords(db, filter);
}

/**
 * What a new list can price: every market (the backup first) and every
 * customer segment, by name. The price list screens read this instead of the
 * settings and customers endpoints, so product staff need no other access.
 */
export async function priceListChoices(db: Database): Promise<{
    markets: Array<{ id: string; name: string; isBackup: boolean }>;
    segments: Array<{ id: string; name: string }>;
}> {
    const [marketRows, segmentRows] = await Promise.all([
        db.select({ id: markets.id, name: markets.name, isBackup: markets.isBackup })
            .from(markets)
            .orderBy(sql`${markets.isBackup} DESC`, asc(markets.name), asc(markets.id)),
        db.select({ id: customerSegments.id, name: customerSegments.name })
            .from(customerSegments)
            .where(sql`${customerSegments.deletedAt} IS NULL`)
            .orderBy(asc(customerSegments.name), asc(customerSegments.id)),
    ]);
    return {
        markets: marketRows.map((row) => ({ ...row, isBackup: Boolean(row.isBackup) })),
        segments: segmentRows,
    };
}

export async function getPriceList(db: Database, id: string): Promise<PriceListRecord> {
    const [record] = await loadRecords(db, { id });
    if (!record) throw new NotFoundError("Price list not found");
    return record;
}

/**
 * One page of a list's SKUs with their tiers, by product name then SKU
 * (`page` from 1). `search` matches the product name or the SKU code.
 */
/** Where a page of a price list's SKUs (product name, then SKU id) stops: the next page starts after it. */
export interface PriceListVariantPosition {
    productName: string;
    variantId: string;
}

function priceListVariantRows(
    db: Database,
    id: string,
    options: { limit: number; offset?: number; search?: string; after?: PriceListVariantPosition | null },
) {
    const search = options.search?.trim().toLowerCase();
    const matches = search
        ? sql`AND (${containsText(products.name, search)} OR ${containsText(productVariants.sku, search)})`
        : sql``;
    const variantsOfList = sql`${productVariants.id} IN (SELECT listed.variant_id FROM price_list_prices AS listed WHERE listed.price_list_id = ${id}) ${matches}`;
    const after = options.after
        ? sql` AND (${products.name} > ${options.after.productName} OR (${products.name} = ${options.after.productName} AND ${productVariants.id} > ${options.after.variantId}))`
        : sql``;
    const rows = db.select({
        variantId: productVariants.id,
        productId: products.id,
        productName: products.name,
        variantLabel: variantOptionLabelSql(productVariants.id),
        isDefault: productVariants.isDefault,
        sku: productVariants.sku,
        basePriceMinor: productVariants.priceMinor,
    })
        .from(productVariants)
        .innerJoin(products, eq(products.id, productVariants.productId))
        .where(sql`${variantsOfList}${after}`)
        .orderBy(asc(products.name), asc(productVariants.id))
        .limit(options.limit)
        .offset(options.offset ?? 0);
    const total = db.select({ n: sql<number>`count(*)` })
        .from(productVariants)
        .innerJoin(products, eq(products.id, productVariants.productId))
        .where(variantsOfList);
    return { rows, total };
}

type PriceListVariantRow = Awaited<ReturnType<typeof priceListVariantRows>["rows"]>[number];

async function withListPrices(db: Database, id: string, variantRows: PriceListVariantRow[]): Promise<PriceListVariantPrices[]> {
    const ids = variantRows.map((row) => row.variantId);
    const priceRows = ids.length === 0 ? [] : await db.select({
        variantId: priceListPrices.variantId,
        currencyCode: priceListPrices.currencyCode,
        amountMinor: priceListPrices.amountMinor,
        compareAtMinor: priceListPrices.compareAtMinor,
        minQuantity: priceListPrices.minQuantity,
    })
        .from(priceListPrices)
        .where(and(
            eq(priceListPrices.priceListId, id),
            sql`${priceListPrices.variantId} IN (SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(ids)}))`,
        ))
        .orderBy(asc(priceListPrices.currencyCode), asc(priceListPrices.minQuantity));
    return variantRows.map((row) => ({
        variantId: row.variantId,
        productId: row.productId,
        productName: row.productName,
        variantLabel: row.isDefault ? null : row.variantLabel,
        sku: row.sku,
        basePriceMinor: row.basePriceMinor,
        prices: priceRows.filter((price) => price.variantId === row.variantId).map(({ variantId: _variantId, ...price }) => price),
    }));
}

/** One numbered page of a price list's SKUs and their prices (the dashboard's editor). */
export async function listPriceListVariants(
    db: Database,
    id: string,
    options: { page?: number; limit?: number; search?: string } = {},
): Promise<{ items: PriceListVariantPrices[]; total: number; page: number; limit: number }> {
    const limit = Math.min(Math.max(Math.floor(options.limit ?? 50), 1), 100);
    const page = Math.max(Math.floor(options.page ?? 1), 1);
    await getPriceList(db, id);
    const query = priceListVariantRows(db, id, { limit, offset: (page - 1) * limit, search: options.search });
    const [variantRows, totalRows] = await Promise.all([query.rows, query.total]);
    return { items: await withListPrices(db, id, variantRows), total: Number(totalRows[0]?.n ?? 0), page, limit };
}

/**
 * The SKUs after `after` (product name, then SKU id) and their prices, at
 * most `limit`, with where the next page starts (null after the last).
 */
export async function listPriceListVariantsAfter(
    db: Database,
    id: string,
    options: { limit: number; search?: string; after: PriceListVariantPosition | null },
): Promise<{ items: PriceListVariantPrices[]; next: PriceListVariantPosition | null }> {
    const limit = Math.min(Math.max(Math.floor(options.limit), 1), 100);
    await getPriceList(db, id);
    const variantRows = await priceListVariantRows(db, id, { limit: limit + 1, search: options.search, after: options.after }).rows;
    const page = variantRows.slice(0, limit);
    const last = page.at(-1);
    return {
        items: await withListPrices(db, id, page),
        next: variantRows.length > limit && last ? { productName: last.productName, variantId: last.variantId } : null,
    };
}

// ─────────────────────────────────────────
// Validation
// ─────────────────────────────────────────

function cleanName(name: string): string {
    const trimmed = name.trim();
    if (!trimmed) throw new ValidationError("Give the price list a name.");
    if (trimmed.length > PRICE_LIST_NAME_MAX_LENGTH) throw new ValidationError(`A price list name is at most ${PRICE_LIST_NAME_MAX_LENGTH} characters.`);
    return trimmed;
}

function cleanDescription(description: string | null | undefined): string | null {
    const trimmed = description?.trim() ?? "";
    if (!trimmed) return null;
    if (trimmed.length > PRICE_LIST_DESCRIPTION_MAX_LENGTH) {
        throw new ValidationError(`A description is at most ${PRICE_LIST_DESCRIPTION_MAX_LENGTH} characters.`);
    }
    return trimmed;
}

function cleanPriority(priority: number | undefined): number {
    const value = priority ?? 0;
    if (!Number.isInteger(value) || value < 0 || value > PRICE_LIST_PRIORITY_MAX) {
        throw new ValidationError(`Priority is a whole number from 0 to ${PRICE_LIST_PRIORITY_MAX}.`);
    }
    return value;
}

function cleanSchedule(startsAt: Date | null, endsAt: Date | null): void {
    if (startsAt && endsAt && endsAt.getTime() <= startsAt.getTime()) {
        throw new ValidationError("The end must be after the start.");
    }
}

/** Seconds precision: the columns hold epoch seconds. */
function toSeconds(value: Date | null | undefined): Date | null {
    if (!value) return null;
    if (Number.isNaN(value.getTime())) throw new ValidationError("Choose a valid date and time.");
    return new Date(Math.floor(value.getTime() / 1_000) * 1_000);
}

async function assertMarketAndSegment(db: Database, kind: PriceListKind, marketId: string, segmentId: string | null): Promise<void> {
    const market = await db.select({ isBackup: markets.isBackup }).from(markets).where(eq(markets.id, marketId)).get();
    if (!market) throw new ValidationError("Choose a market for the price list.");
    if (kind !== "segment" && market.isBackup) {
        throw new ValidationError("The backup market sells at your product prices. Market and sale price lists are for your other markets; use a customer segment list for wholesale prices here.");
    }
    if (kind === "segment") {
        if (!segmentId) throw new ValidationError("Choose the customer segment this price list is for.");
        const segment = await db.select({ deletedAt: customerSegments.deletedAt }).from(customerSegments).where(eq(customerSegments.id, segmentId)).get();
        if (!segment || segment.deletedAt !== null) throw new ValidationError("That customer segment no longer exists. Choose another.");
    } else if (segmentId) {
        throw new ValidationError("Only a customer segment price list names a segment.");
    }
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
function priceListWriteError(error: unknown): unknown {
    if (error instanceof AppError) return error;
    if (isBatchGuardError(error, PRICE_LIST_REVISION_CONFLICT)) {
        return new ConflictError("This price list changed in another session. Reload it, then save again.");
    }
    const text = collectErrorText(error);
    if (/PRICE_LIST_BACKUP_MARKET/.test(text)) return new ValidationError("Market and sale price lists are for markets other than the backup market.");
    if (/FOREIGN KEY|foreign key/i.test(text)) return new ConflictError("A market, segment or product of this price list was removed. Reload and try again.");
    if (/price_list_prices/i.test(text) && /UNIQUE|PRIMARY|duplicate/i.test(text)) return new ConflictError("A product has two prices for the same quantity.");
    return error;
}

function revisionGuard(db: Database, id: string, expectedRevision: number): SQLiteBatchItem {
    return buildBatchGuard(
        db,
        sql`EXISTS (SELECT 1 FROM ${priceLists} WHERE ${priceLists.id} = ${id} AND ${priceLists.revision} = ${expectedRevision})`,
        PRICE_LIST_REVISION_CONFLICT,
    );
}

// ─────────────────────────────────────────
// Writes
// ─────────────────────────────────────────

export async function createPriceList(db: Database, input: PriceListInput): Promise<PriceListRecord> {
    if (!isPriceListKind(input.kind)) throw new ValidationError("Choose what the price list is for.");
    const name = cleanName(input.name);
    const description = cleanDescription(input.description);
    const priority = cleanPriority(input.priority);
    const startsAt = toSeconds(input.startsAt);
    const endsAt = toSeconds(input.endsAt);
    cleanSchedule(startsAt, endsAt);
    const segmentId = input.kind === "segment" ? input.segmentId ?? null : input.segmentId ?? null;
    await assertMarketAndSegment(db, input.kind, input.marketId, segmentId);
    const [count] = await db.select({ n: sql<number>`count(*)` }).from(priceLists);
    if (Number(count?.n ?? 0) >= MAX_PRICE_LISTS) throw new ValidationError(`A store has at most ${MAX_PRICE_LISTS} price lists.`);
    const id = `pl_${nanoid(16)}`;
    try {
        await db.insert(priceLists).values({
            id,
            name,
            description,
            kind: input.kind,
            marketId: input.marketId,
            segmentId,
            status: input.status ?? "draft",
            startsAt,
            endsAt,
            priority,
            revision: 1,
        });
    } catch (error) {
        throw priceListWriteError(error);
    }
    return getPriceList(db, id);
}

export async function updatePriceList(db: Database, id: string, update: PriceListUpdate): Promise<PriceListRecord> {
    const current = await getPriceList(db, id);
    if (current.revision !== update.expectedRevision) {
        throw new ConflictError("This price list changed in another session. Reload it, then save again.");
    }
    const kind = update.kind ?? current.kind;
    if (!isPriceListKind(kind)) throw new ValidationError("Choose what the price list is for.");
    const marketId = update.marketId ?? current.marketId;
    const segmentId = kind === "segment"
        ? (update.segmentId === undefined ? current.segmentId : update.segmentId)
        : (update.segmentId === undefined ? null : update.segmentId);
    const startsAt = update.startsAt === undefined ? current.startsAt : toSeconds(update.startsAt);
    const endsAt = update.endsAt === undefined ? current.endsAt : toSeconds(update.endsAt);
    cleanSchedule(startsAt, endsAt);
    if (kind !== current.kind || marketId !== current.marketId || segmentId !== current.segmentId) {
        await assertMarketAndSegment(db, kind, marketId, segmentId);
    }
    try {
        await safeBatch(db, [
            revisionGuard(db, id, update.expectedRevision),
            db.update(priceLists).set({
                name: update.name === undefined ? current.name : cleanName(update.name),
                description: update.description === undefined ? current.description : cleanDescription(update.description),
                kind,
                marketId,
                segmentId,
                status: update.status ?? current.status,
                startsAt,
                endsAt,
                priority: update.priority === undefined ? current.priority : cleanPriority(update.priority),
                revision: sql`${priceLists.revision} + 1`,
                updatedAt: sql`unixepoch()`,
            }).where(eq(priceLists.id, id)),
        ] as never);
    } catch (error) {
        throw priceListWriteError(error);
    }
    return getPriceList(db, id);
}

export async function deletePriceList(db: Database, id: string, expectedRevision: number): Promise<void> {
    await getPriceList(db, id);
    try {
        await safeBatch(db, [
            revisionGuard(db, id, expectedRevision),
            db.delete(priceLists).where(eq(priceLists.id, id)),
        ] as never);
    } catch (error) {
        throw priceListWriteError(error);
    }
}

interface StoredTier {
    v: string;
    c: string;
    a: number;
    x: number | null;
    q: number;
}

/**
 * Replaces the tiers of the SKUs in `set` and removes the SKUs in `remove`,
 * in one guarded batch of four statements whatever the size (the rows travel
 * as one JSON parameter): the revision guard, one delete, one insert and the
 * revision bump. Prices are entered in the market's currency at its price
 * increment (whole taka by default for BDT).
 */
export async function setPriceListPrices(db: Database, id: string, update: PriceListPricesUpdate): Promise<PriceListRecord> {
    const current = await getPriceList(db, id);
    if (current.revision !== update.expectedRevision) {
        throw new ConflictError("This price list changed in another session. Reload it, then save again.");
    }
    const set = update.set ?? [];
    const remove = [...new Set(update.remove ?? [])];
    const touched = [...new Set([...set.map((entry) => entry.variantId), ...remove])];
    if (touched.length === 0) return current;
    if (touched.length > PRICE_LIST_WRITE_MAX_VARIANTS) {
        throw new ValidationError(`Save at most ${PRICE_LIST_WRITE_MAX_VARIANTS} products' prices at a time.`);
    }
    if (set.length !== new Set(set.map((entry) => entry.variantId)).size) {
        throw new ValidationError("Each product appears once in a save.");
    }
    const currency = current.currencyCode;
    const decimalPlaces = getDecimalPlaces(currency);
    const tiers: StoredTier[] = [];
    for (const entry of set) {
        if (entry.prices.length === 0) throw new ValidationError("Give every product a price, or remove it from the list.");
        if (entry.prices.length > MAX_PRICE_LIST_QUANTITY_BREAKS) {
            throw new ValidationError(`A product has at most ${MAX_PRICE_LIST_QUANTITY_BREAKS} prices in one list (its price and quantity breaks).`);
        }
        const quantities = new Set<number>();
        for (const tier of entry.prices) {
            const minQuantity = tier.minQuantity ?? 1;
            if (!Number.isInteger(minQuantity) || minQuantity < 1 || minQuantity > PRICE_LIST_MIN_QUANTITY_MAX) {
                throw new ValidationError(`A quantity break starts at 1 to ${PRICE_LIST_MIN_QUANTITY_MAX} units.`);
            }
            if (quantities.has(minQuantity)) throw new ValidationError("A product has one price per quantity.");
            quantities.add(minQuantity);
            let amountMinor: number;
            let compareAtMinor: number | null = null;
            try {
                amountMinor = toIncrementMinor(tier.amount, decimalPlaces, current.priceIncrementMinor, currency);
                if (tier.compareAt !== undefined && tier.compareAt !== null && tier.compareAt > 0) {
                    compareAtMinor = toIncrementMinor(tier.compareAt, decimalPlaces, current.priceIncrementMinor, currency);
                }
            } catch (error) {
                if (error instanceof PriceIncrementError || error instanceof RangeError) throw new ValidationError(error.message);
                throw error;
            }
            if (amountMinor <= 0) throw new ValidationError("A price is above zero.");
            if (compareAtMinor !== null && compareAtMinor <= amountMinor) {
                throw new ValidationError(`A compare-at price is above the price (${fromMinor(amountMinor, decimalPlaces)}).`);
            }
            tiers.push({ v: entry.variantId, c: currency, a: amountMinor, x: compareAtMinor, q: minQuantity });
        }
        if (!quantities.has(1)) throw new ValidationError("Every product needs a price for 1 unit before its quantity breaks.");
    }
    if (set.length > 0) {
        const ids = JSON.stringify(set.map((entry) => entry.variantId));
        const live = await db.select({ id: productVariants.id })
            .from(productVariants)
            .where(sql`${productVariants.id} IN (SELECT CAST(value AS TEXT) FROM json_each(${ids})) AND ${productVariants.deletedAt} IS NULL`);
        if (live.length !== set.length) throw new ValidationError("A product option you priced no longer exists. Reload and try again.");
        // The list's row count after this write stays within the limit.
        const [kept] = await db.select({ n: sql<number>`count(*)` })
            .from(priceListPrices)
            .where(and(
                eq(priceListPrices.priceListId, id),
                sql`${priceListPrices.variantId} NOT IN (SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(touched)}))`,
            ));
        if (Number(kept?.n ?? 0) + tiers.length > MAX_PRICE_LIST_PRICES) {
            throw new ValidationError(`A price list holds at most ${MAX_PRICE_LIST_PRICES} prices.`);
        }
    }
    const touchedJson = JSON.stringify(touched);
    const tiersJson = JSON.stringify(tiers);
    try {
        await safeBatch(db, [
            revisionGuard(db, id, update.expectedRevision),
            db.delete(priceListPrices).where(and(
                eq(priceListPrices.priceListId, id),
                sql`${priceListPrices.variantId} IN (SELECT CAST(value AS TEXT) FROM json_each(${touchedJson}))`,
            )),
            ...(tiers.length > 0 ? [db.insert(priceListPrices).select(
                db.select({
                    priceListId: sql<string>`${id}`.as("price_list_id"),
                    variantId: sql<string>`CAST(json_extract(value, '$.v') AS TEXT)`.as("variant_id"),
                    currencyCode: sql<string>`CAST(json_extract(value, '$.c') AS TEXT)`.as("currency_code"),
                    amountMinor: sql<number>`CAST(json_extract(value, '$.a') AS INTEGER)`.as("amount_minor"),
                    compareAtMinor: sql<number | null>`CAST(json_extract(value, '$.x') AS INTEGER)`.as("compare_at_minor"),
                    minQuantity: sql<number>`CAST(json_extract(value, '$.q') AS INTEGER)`.as("min_quantity"),
                    createdAt: sql<Date>`unixepoch()`.as("created_at"),
                    updatedAt: sql<Date>`unixepoch()`.as("updated_at"),
                }).from(sql`json_each(${tiersJson})`),
            ) as unknown as SQLiteBatchItem] : []),
            db.update(priceLists)
                .set({ revision: sql`${priceLists.revision} + 1`, updatedAt: sql`unixepoch()` })
                .where(eq(priceLists.id, id)),
        ] as never);
    } catch (error) {
        throw priceListWriteError(error);
    }
    return getPriceList(db, id);
}
