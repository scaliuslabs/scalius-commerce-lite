// The dashboard's ⌘K search: a few records of each kind for one typed term,
// from one request. Built for a store with a million orders: every lookup is
// an exact match on a unique or plain index, an FTS5 prefix match that reads
// only its newest matches, or a match in a small table, and each kind stops at
// GLOBAL_SEARCH_LIMIT rows. Nothing counts, and nothing scans a large table
// with LIKE or instr (PostgreSQL, which has no FTS5, uses the bounded
// fallback the list searches use).
import { and, desc, eq, inArray, isNull, or, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import {
    categories,
    collections,
    customers,
    orders,
    pages,
    productVariants,
    products,
    promotionCodes,
    promotions,
} from "@scalius/database/schema";
import { ftsMatch, isFts5SearchEnabled, sanitizeFtsQuery } from "@scalius/core/search";
import { containsText } from "@scalius/core/utils/text-match";
import { parseOrderNumberSearch } from "@scalius/shared/order-utils";
import { toLatinDigits } from "@scalius/shared/phone-input";

export const GLOBAL_SEARCH_LIMIT = 5;
/** FTS5 candidates read per kind, newest first; trashed rows drop out after. */
const FTS_CANDIDATES = 20;

export const GLOBAL_SEARCH_KINDS = ["orders", "customers", "products", "discounts", "collections", "categories", "pages"] as const;
export type GlobalSearchKind = (typeof GLOBAL_SEARCH_KINDS)[number];

export interface GlobalSearchResult {
    orders: Array<{ id: string; orderNumber: number | null; customerName: string; status: string }>;
    customers: Array<{ id: string; name: string; phone: string | null; email: string | null; origin: string; latestOrderName: string | null }>;
    products: Array<{ id: string; name: string; isActive: boolean; matchedSku: string | null }>;
    discounts: Array<{ id: string; name: string; code: string | null; status: string }>;
    collections: Array<{ id: string; name: string }>;
    categories: Array<{ id: string; name: string }>;
    pages: Array<{ id: string; title: string; contentType: string }>;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Not trashed, as a filter no index may serve. Without table statistics (a
 * fresh D1 has none) SQLite otherwise walks the `deleted_at, created_at`
 * index of every live order to honour ORDER BY and checks each against the
 * lookup: a million rows for a phone with old orders. The unary `+` keeps the
 * lookup's own index (order number, phone, email, FTS5 rowids) in charge.
 */
const live = (column: SQLWrapper) => sql`+${column} IS NULL`;
/** Newest first, sorted after the lookup (at most a few rows) instead of along a date index. */
const newestFirst = (column: SQLWrapper) => sql`+${column} DESC`;

/**
 * The stored forms a typed phone may have: "+8801712345678", "8801712345678",
 * "01712345678". Only a whole number (8 digits or more) is looked up, exactly.
 */
export function phoneLookupValues(input: string): string[] {
    const compact = toLatinDigits(input).replace(/[\s().-]/g, "");
    if (!/^\+?\d{8,15}$/.test(compact)) return [];
    const digits = compact.replace(/^\+/, "").replace(/^00/, "");
    const national = digits.startsWith("880") ? digits.slice(3) : digits.startsWith("0") ? digits.slice(1) : digits;
    const forms = new Set([digits, `+${digits}`, national, `0${national}`, `880${national}`, `+880${national}`]);
    return [...forms];
}

/** Rowids of the newest FTS5 matches, or null when this database has no FTS5. */
async function ftsRowids(
    db: Database,
    table: "orders_fts" | "customers_fts" | "products_fts" | "categories_fts" | "pages_fts",
    term: string,
    column?: "name" | "title",
): Promise<number[] | null> {
    if (!isFts5SearchEnabled(db)) return null;
    const words = sanitizeFtsQuery(term);
    if (!words) return [];
    const match = column ? `${column} : (${words})` : words;
    // FTS5 walks its rowids in descending order and stops at the limit: the
    // cost does not grow with the number of matching rows.
    const rows: unknown[] = await db.all(
        sql`SELECT rowid FROM ${sql.raw(table)} WHERE ${sql.raw(table)} MATCH ${match} ORDER BY rowid DESC LIMIT ${FTS_CANDIDATES}`,
    );
    // Some providers return rows as arrays, others as objects.
    return rows.map((row) => Number(Array.isArray(row) ? row[0] : (row as { rowid: unknown }).rowid));
}

/** `table.rowid IN (…)` for FTS5 candidates, or the provider's bounded text fallback. */
function textCondition(
    db: Database,
    rowids: number[] | null,
    fallback: () => SQL | undefined,
    source: "orders" | "customers" | "products" | "categories" | "pages",
): SQL | undefined {
    if (rowids === null) return fallback();
    return rowids.length ? sql`${sql.raw(source)}.rowid IN (${sql.join(rowids.map((id) => sql`${id}`), sql`, `)})` : undefined;
}

function anyOf(conditions: Array<SQL | undefined>): SQL | undefined {
    const present = conditions.filter((condition): condition is SQL => condition !== undefined);
    return present.length ? or(...present) : undefined;
}

async function searchOrders(db: Database, term: string): Promise<GlobalSearchResult["orders"]> {
    const orderNumber = parseOrderNumberSearch(term);
    const phones = phoneLookupValues(term);
    const email = EMAIL.test(term) ? term.toLowerCase() : null;
    const rowids = orderNumber === null && phones.length === 0 && !email ? await ftsRowids(db, "orders_fts", term) : [];
    const match = anyOf([
        orderNumber === null ? undefined : eq(orders.orderNumber, orderNumber),
        phones.length ? inArray(orders.customerPhone, phones) : undefined,
        email ? sql`lower(trim(${orders.customerEmail})) = ${email}` : undefined,
        textCondition(db, rowids, () => ftsMatch(db, "orders_fts", "orders", term), "orders"),
    ]);
    if (!match) return [];
    return db.select({ id: orders.id, orderNumber: orders.orderNumber, customerName: orders.customerName, status: orders.status })
        .from(orders)
        .where(and(live(orders.deletedAt), match))
        .orderBy(newestFirst(orders.createdAt))
        .limit(GLOBAL_SEARCH_LIMIT);
}

async function searchCustomers(db: Database, term: string): Promise<GlobalSearchResult["customers"]> {
    const phones = phoneLookupValues(term);
    const email = EMAIL.test(term) ? term.toLowerCase() : null;
    const rowids = phones.length === 0 && !email ? await ftsRowids(db, "customers_fts", term) : [];
    const match = anyOf([
        phones.length ? inArray(customers.phone, phones) : undefined,
        email ? inArray(customers.email, [...new Set([term, email])]) : undefined,
        textCondition(db, rowids, () => ftsMatch(db, "customers_fts", "customers", term), "customers"),
    ]);
    if (!match) return [];
    const rows = await db.select({
        id: customers.id,
        name: customers.name,
        phone: customers.phone,
        email: customers.email,
        origin: customers.origin,
    })
        .from(customers)
        .where(and(live(customers.deletedAt), match))
        .orderBy(newestFirst(customers.createdAt))
        .limit(GLOBAL_SEARCH_LIMIT);
    // A guest record is titled by the buyer on its latest order: one lookup per
    // guest (five at most) on the (customer_id, deleted_at, created_at) index.
    const result: GlobalSearchResult["customers"] = [];
    for (const row of rows) {
        let latestOrderName: string | null = null;
        if (row.origin === "order") {
            const [latest] = await db.select({ name: orders.customerName })
                .from(orders)
                .where(and(eq(orders.customerId, row.id), sql`${orders.customerId} IS NOT NULL`, isNull(orders.deletedAt)))
                .orderBy(desc(orders.customerId), desc(orders.deletedAt), desc(orders.createdAt))
                .limit(1);
            latestOrderName = latest?.name ?? null;
        }
        result.push({ ...row, phone: row.phone ?? null, email: row.email ?? null, latestOrderName });
    }
    return result;
}

async function searchProducts(db: Database, term: string): Promise<GlobalSearchResult["products"]> {
    const key = term.trim().toLowerCase();
    // A SKU or barcode is one exact, indexed lookup (`lower(trim(…))` unique indexes).
    const variantRows = await db.select({ productId: productVariants.productId, sku: productVariants.sku })
        .from(productVariants)
        .where(and(
            isNull(productVariants.deletedAt),
            or(
                sql`lower(trim(${productVariants.sku})) = ${key}`,
                // The barcode index is partial: repeat its condition so the planner uses it.
                sql`(${productVariants.barcode} IS NOT NULL AND trim(${productVariants.barcode}) <> '' AND lower(trim(${productVariants.barcode})) = ${key})`,
            ),
        ))
        .limit(GLOBAL_SEARCH_LIMIT);
    const skuByProduct = new Map(variantRows.map((row) => [row.productId, row.sku]));
    const rowids = await ftsRowids(db, "products_fts", term, "name");
    const match = anyOf([
        skuByProduct.size ? inArray(products.id, [...skuByProduct.keys()]) : undefined,
        textCondition(db, rowids, () => ftsMatch(db, "products_fts", "products", term, { column: "name" }), "products"),
    ]);
    if (!match) return [];
    const rows = await db.select({ id: products.id, name: products.name, isActive: products.isActive })
        .from(products)
        .where(and(live(products.deletedAt), match))
        .orderBy(newestFirst(products.updatedAt))
        .limit(GLOBAL_SEARCH_LIMIT);
    // An exact SKU or barcode leads.
    return rows
        .map((row) => ({ ...row, matchedSku: skuByProduct.get(row.id) ?? null }))
        .sort((a, b) => Number(b.matchedSku !== null) - Number(a.matchedSku !== null));
}

/** The next string after every string that starts with `prefix`, for an index range. */
function prefixEnd(prefix: string): string {
    return prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
}

async function searchDiscounts(db: Database, term: string): Promise<GlobalSearchResult["discounts"]> {
    // Codes are stored upper-case: a prefix is an index range on the unique code index.
    const code = term.trim().toUpperCase();
    const codeRows = /^[A-Z0-9_-]{2,50}$/.test(code)
        ? await db.select({ promotionId: promotionCodes.promotionId, code: promotionCodes.code })
            .from(promotionCodes)
            .where(and(sql`${promotionCodes.normalizedCode} >= ${code}`, sql`${promotionCodes.normalizedCode} < ${prefixEnd(code)}`))
            .orderBy(promotionCodes.normalizedCode)
            .limit(GLOBAL_SEARCH_LIMIT)
        : [];
    const codeByPromotion = new Map<string, string>();
    for (const row of codeRows) if (!codeByPromotion.has(row.promotionId)) codeByPromotion.set(row.promotionId, row.code);
    // Discounts themselves are few (bulk codes share one discount): names match directly.
    const match = anyOf([
        codeByPromotion.size ? inArray(promotions.id, [...codeByPromotion.keys()]) : undefined,
        containsText(promotions.name, term),
        containsText(promotions.title, term),
    ]);
    const rows = await db.select({ id: promotions.id, name: promotions.name, status: promotions.status })
        .from(promotions)
        .where(and(isNull(promotions.deletedAt), match))
        .orderBy(desc(promotions.updatedAt))
        .limit(GLOBAL_SEARCH_LIMIT);
    return rows.map((row) => ({ ...row, code: codeByPromotion.get(row.id) ?? null }));
}

async function searchCollections(db: Database, term: string): Promise<GlobalSearchResult["collections"]> {
    // Collections are a small table (hundreds at most): a direct name match is bounded.
    return db.select({ id: collections.id, name: collections.name })
        .from(collections)
        .where(and(isNull(collections.deletedAt), containsText(collections.name, term)))
        .orderBy(collections.sortOrder)
        .limit(GLOBAL_SEARCH_LIMIT);
}

async function searchCategories(db: Database, term: string): Promise<GlobalSearchResult["categories"]> {
    const rowids = await ftsRowids(db, "categories_fts", term, "name");
    const match = textCondition(db, rowids, () => ftsMatch(db, "categories_fts", "categories", term, { column: "name" }), "categories");
    if (!match) return [];
    return db.select({ id: categories.id, name: categories.name })
        .from(categories)
        .where(and(live(categories.deletedAt), match))
        .limit(GLOBAL_SEARCH_LIMIT);
}

async function searchPages(db: Database, term: string): Promise<GlobalSearchResult["pages"]> {
    const rowids = await ftsRowids(db, "pages_fts", term, "title");
    const match = textCondition(db, rowids, () => ftsMatch(db, "pages_fts", "pages", term, { column: "title" }), "pages");
    if (!match) return [];
    return db.select({ id: pages.id, title: pages.title, contentType: pages.contentType })
        .from(pages)
        .where(and(live(pages.deletedAt), match))
        .limit(GLOBAL_SEARCH_LIMIT);
}

const SEARCHERS: { [K in GlobalSearchKind]: (db: Database, term: string) => Promise<GlobalSearchResult[K]> } = {
    orders: searchOrders,
    customers: searchCustomers,
    products: searchProducts,
    discounts: searchDiscounts,
    collections: searchCollections,
    categories: searchCategories,
    pages: searchPages,
};

/**
 * Searches the kinds the caller may read. Kinds run one after another, so the
 * request holds one D1 connection and a slow kind never multiplies.
 */
export async function globalSearch(db: Database, term: string, kinds: readonly GlobalSearchKind[]): Promise<GlobalSearchResult> {
    const result: GlobalSearchResult = { orders: [], customers: [], products: [], discounts: [], collections: [], categories: [], pages: [] };
    const query = term.normalize("NFC").trim();
    if (query.length < 2) return result;
    for (const kind of kinds) {
        (result as Record<GlobalSearchKind, unknown>)[kind] = await SEARCHERS[kind](db, query);
    }
    return result;
}
