// The product editor's kit and page-offer sections (products/kits.ts): a
// SKU's components, and the SKUs of other products its page shows under its
// own. Both write under the product aggregate revision in one guarded batch;
// every check here has a guard trigger behind it (migration 0224), so a write
// that races another is refused with the same reason.
import type { BatchItem } from "drizzle-orm/batch";
import { and, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "@scalius/database/client";
import { productPageOffers, products, productVariants, variantComponents } from "@scalius/database/schema";
import { ValidationError } from "@scalius/core/errors";
import { discountedPriceMinor, fromMinor } from "@scalius/shared/money";
import {
    KIT_COMPONENT_QUANTITY_MAX,
    KIT_COMPONENTS_MAX,
    PRODUCT_PAGE_OFFERS_MAX,
    kitAvailableQuantity,
    kitComponentProblem,
    kitPrice,
    kitRefusal,
    parseVariantOptionValues,
    productPublishedToChannelSql,
    productVariantBarcodeIdentityEquals,
    resolveProductMediaProjectionRows,
    resolveSkuImageRepresentation,
    selectSkuMediaProjectionRows,
    variantOptionValuesSql,
    type KitComponentProblem,
    type KitRefusalReason,
    type ProductMediaProjection,
} from "../products";
import { readStoreCurrency } from "../markets";
import { containsText } from "../../utils/text-match";
import { sanitizeSearchTokens, searchKeyColumn, searchKeys } from "../../search";
import { getBarcodeIdentityKey } from "@scalius/shared/barcode-identity";

type SQLiteBatchItem = BatchItem<"sqlite">;

/** Ids read with a bounded IN list: D1 binds at most 100 parameters. */
const ID_CHUNK = 90;

function refuse(reason: KitRefusalReason, extra: { field?: string; variantId?: string } = {}): never {
    const refusal = kitRefusal(reason, extra);
    throw new ValidationError(refusal.message, refusal.details);
}

const skuIdSchema = z.string().trim().min(1).max(160);

/** The `kits` section's write: one SKU's components (an empty list makes it an ordinary SKU again). */
export const productKitPatchFields = {
    /** The SKU of this product that is (or stops being) a kit. */
    variantId: skuIdSchema,
    /** Its items in display order, each a SKU of any product with how many one kit holds. */
    components: z.array(z.object({
        variantId: skuIdSchema,
        quantity: z.number().int().min(1).max(KIT_COMPONENT_QUANTITY_MAX),
    }).strict()).max(100),
};

/** The `page_offers` section's write: the SKUs of other products this page shows under its own, in order. */
export const productPageOffersPatchFields = {
    variantIds: z.array(skuIdSchema).max(100),
};

interface SkuFacts {
    id: string;
    productId: string;
    deleted: boolean;
    giftCard: boolean;
    isKit: boolean;
    isComponent: boolean;
    stock: number;
    reservedStock: number;
    preorderStock: number;
}

async function readSkuFacts(db: Database, ids: readonly string[]): Promise<Map<string, SkuFacts>> {
    const facts = new Map<string, SkuFacts>();
    const unique = [...new Set(ids)];
    for (let start = 0; start < unique.length; start += ID_CHUNK) {
        const rows = await db.select({
            id: productVariants.id,
            productId: productVariants.productId,
            deleted: sql<number>`(${productVariants.deletedAt} IS NOT NULL OR ${products.deletedAt} IS NOT NULL)`,
            giftCard: products.isGiftCard,
            isKit: sql<number>`EXISTS (SELECT 1 FROM variant_components AS fact_kit WHERE fact_kit.kit_variant_id = ${productVariants.id})`,
            isComponent: sql<number>`EXISTS (SELECT 1 FROM variant_components AS fact_part WHERE fact_part.component_variant_id = ${productVariants.id})`,
            stock: productVariants.stock,
            reservedStock: productVariants.reservedStock,
            preorderStock: productVariants.preorderStock,
        }).from(productVariants)
            .innerJoin(products, eq(products.id, productVariants.productId))
            .where(inArray(productVariants.id, unique.slice(start, start + ID_CHUNK)))
            .all();
        for (const row of rows) {
            facts.set(row.id, {
                id: row.id,
                productId: row.productId,
                deleted: Number(row.deleted) === 1,
                giftCard: row.giftCard === true,
                isKit: Number(row.isKit) === 1,
                isComponent: Number(row.isComponent) === 1,
                stock: Number(row.stock),
                reservedStock: Number(row.reservedStock),
                preorderStock: Number(row.preorderStock),
            });
        }
    }
    return facts;
}

/**
 * Replaces one SKU's components, refusing an illegal kit with its reason
 * (`KIT_REFUSALS`): more than `KIT_COMPONENTS_MAX` items, an item twice, the
 * SKU itself, a deleted SKU, a gift card, a kit inside a kit, a kit that is
 * another kit's item, or a kit SKU that still holds stock. A SKU that becomes
 * a kit stops tracking stock of its own. Null when the product is gone.
 */
export async function buildProductKitReplaceStatements(
    db: Database,
    productId: string,
    input: { variantId: string; components: ReadonlyArray<{ variantId: string; quantity: number }> },
): Promise<SQLiteBatchItem[] | null> {
    const product = await db.select({ id: products.id }).from(products).where(eq(products.id, productId)).get();
    if (!product) return null;
    const components = input.components;
    if (components.length > KIT_COMPONENTS_MAX) refuse("kit_component_limit");
    const ids = components.map((component) => component.variantId);
    const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
    if (duplicate) refuse("kit_component_duplicate", { variantId: duplicate });
    if (ids.includes(input.variantId)) refuse("kit_component_self", { variantId: input.variantId });
    const facts = await readSkuFacts(db, [input.variantId, ...ids]);
    const kit = facts.get(input.variantId);
    if (!kit || kit.deleted || kit.productId !== productId) refuse("kit_variant_not_found", { field: "variantId", variantId: input.variantId });
    if (components.length > 0) {
        if (kit.giftCard) refuse("kit_gift_card", { field: "variantId" });
        if (kit.isComponent) refuse("kit_is_component", { field: "variantId" });
        for (const id of ids) {
            const part = facts.get(id);
            if (!part || part.deleted) refuse("kit_component_missing", { variantId: id });
            if (part.giftCard) refuse("kit_component_gift_card", { variantId: id });
            if (part.isKit) refuse("kit_component_nested", { variantId: id });
        }
        if (kit.stock !== 0 || kit.reservedStock !== 0 || kit.preorderStock !== 0) refuse("kit_has_stock", { field: "variantId" });
    }
    const statements: SQLiteBatchItem[] = [db.delete(variantComponents).where(eq(variantComponents.kitVariantId, input.variantId))];
    if (components.length > 0) {
        statements.push(db.insert(variantComponents).values(components.map((component, position) => ({
            kitVariantId: input.variantId,
            componentVariantId: component.variantId,
            quantity: component.quantity,
            position,
        }))));
        // A kit has no stock of its own: its items carry it.
        statements.push(db.update(productVariants).set({ trackInventory: false, updatedAt: sql`unixepoch()` })
            .where(and(eq(productVariants.id, input.variantId), eq(productVariants.trackInventory, true))));
    }
    return statements;
}

/** Replaces the page's offers (SKUs of other products, in order). Null when the product is gone. */
export async function buildProductPageOffersReplaceStatements(
    db: Database,
    productId: string,
    variantIds: readonly string[],
): Promise<SQLiteBatchItem[] | null> {
    const product = await db.select({ id: products.id }).from(products).where(eq(products.id, productId)).get();
    if (!product) return null;
    if (variantIds.length > PRODUCT_PAGE_OFFERS_MAX) refuse("page_offer_limit", { field: "variantIds" });
    const duplicate = variantIds.find((id, index) => variantIds.indexOf(id) !== index);
    if (duplicate) refuse("page_offer_duplicate", { field: "variantIds", variantId: duplicate });
    const facts = await readSkuFacts(db, variantIds);
    for (const id of variantIds) {
        const sku = facts.get(id);
        if (!sku || sku.deleted) refuse("page_offer_missing", { field: "variantIds", variantId: id });
        if (sku.productId === productId) refuse("page_offer_own_sku", { field: "variantIds", variantId: id });
    }
    const statements: SQLiteBatchItem[] = [db.delete(productPageOffers).where(eq(productPageOffers.productId, productId))];
    if (variantIds.length > 0) {
        statements.push(db.insert(productPageOffers).values(variantIds.map((variantId, position) => ({ productId, variantId, position }))));
    }
    return statements;
}

/** One SKU (a component or a placed offer) as the editor reads it, with its product's state. */
function selectEditorSkuFacts(db: Database, scope: ReturnType<typeof sql>) {
    return db.select({
        ownerId: sql<string>`editor_sku.owner_id`.as("ek_owner_id"),
        variantId: sql<string>`editor_sku.variant_id`.as("ek_variant_id"),
        quantity: sql<number>`editor_sku.quantity`.mapWith(Number).as("ek_quantity"),
        position: sql<number>`editor_sku.position`.mapWith(Number).as("ek_position"),
        variantLive: sql<number>`editor_variant.id IS NOT NULL AND editor_variant.deleted_at IS NULL`.mapWith(Number).as("ek_variant_live"),
        productId: sql<string | null>`editor_product.id`.as("ek_product_id"),
        productName: sql<string | null>`editor_product.name`.as("ek_product_name"),
        productActive: sql<number | null>`editor_product.is_active`.as("ek_product_active"),
        productDeleted: sql<number | null>`editor_product.deleted_at IS NOT NULL`.as("ek_product_deleted"),
        productGiftCard: sql<number | null>`editor_product.is_gift_card`.as("ek_product_gift_card"),
        productPublished: sql<number | null>`${productPublishedToChannelSql(sql`editor_product.id`)}`.as("ek_product_published"),
        productDiscountType: sql<string | null>`editor_product.discount_type`.as("ek_product_discount_type"),
        productDiscountBps: sql<number | null>`editor_product.discount_bps`.as("ek_product_discount_bps"),
        productDiscountAmountMinor: sql<number | null>`editor_product.discount_amount_minor`.as("ek_product_discount_amount_minor"),
        sku: sql<string | null>`editor_variant.sku`.as("ek_sku"),
        priceMinor: sql<number | null>`editor_variant.price_minor`.as("ek_price_minor"),
        discountType: sql<string | null>`editor_variant.discount_type`.as("ek_discount_type"),
        discountBps: sql<number | null>`editor_variant.discount_bps`.as("ek_discount_bps"),
        discountAmountMinor: sql<number | null>`editor_variant.discount_amount_minor`.as("ek_discount_amount_minor"),
        stock: sql<number | null>`editor_variant.stock`.as("ek_stock"),
        reservedStock: sql<number | null>`editor_variant.reserved_stock`.as("ek_reserved_stock"),
        trackInventory: sql<number | null>`editor_variant.track_inventory`.as("ek_track_inventory"),
        options: variantOptionValuesSql(sql`editor_sku.variant_id`).as("ek_options"),
        isKit: sql<number>`EXISTS (SELECT 1 FROM variant_components AS editor_kit WHERE editor_kit.kit_variant_id = editor_sku.variant_id)`.as("ek_is_kit"),
    }).from(sql`${scope} AS editor_sku
        LEFT JOIN product_variants AS editor_variant ON editor_variant.id = editor_sku.variant_id
        LEFT JOIN products AS editor_product ON editor_product.id = editor_variant.product_id`);
}

type EditorSkuRow = Awaited<ReturnType<ReturnType<typeof selectEditorSkuFacts>["all"]>>[number];

function editorProblem(row: EditorSkuRow): KitComponentProblem | null {
    return kitComponentProblem({
        variantLive: Number(row.variantLive) === 1,
        productActive: row.productActive === null ? null : Number(row.productActive) === 1,
        productDeleted: row.productDeleted === null ? null : Number(row.productDeleted) === 1,
        productPublished: row.productPublished === null ? null : Number(row.productPublished) === 1,
        productGiftCard: row.productGiftCard === null ? null : Number(row.productGiftCard) === 1,
    });
}

/** A SKU's price in the store's currency before markets (its own discount, else its product's). */
function storePriceMinor(row: Pick<EditorSkuRow, "priceMinor" | "discountType" | "discountBps" | "discountAmountMinor" | "productDiscountType" | "productDiscountBps" | "productDiscountAmountMinor">, incrementMinor: number): number {
    const own = (row.discountType === "percentage" && Number(row.discountBps) > 0) || (row.discountType === "flat" && Number(row.discountAmountMinor) > 0);
    return own
        ? discountedPriceMinor(Number(row.priceMinor ?? 0), row.discountType, Number(row.discountBps ?? 0), Number(row.discountAmountMinor ?? 0), incrementMinor)
        : discountedPriceMinor(Number(row.priceMinor ?? 0), row.productDiscountType, Number(row.productDiscountBps ?? 0), Number(row.productDiscountAmountMinor ?? 0), incrementMinor);
}

/**
 * The product's kits as the editor reads them, in the store's currency: each
 * kit SKU's items with their price, exact stock and any problem, the kit's
 * price against them, how many can be sold, and why none can when a
 * component can't be sold (a buyer sees the kit unavailable).
 */
export async function readProductKitsSection(db: Database, productId: string) {
    const [product, rows, kitSkus, currency] = await Promise.all([
        db.select({ aggregateRevision: products.aggregateRevision, discountType: products.discountType, discountBps: products.discountBps, discountAmountMinor: products.discountAmountMinor })
            .from(products).where(eq(products.id, productId)).get(),
        selectEditorSkuFacts(db, sql`(SELECT kit_row.kit_variant_id AS owner_id, kit_row.component_variant_id AS variant_id, kit_row.quantity AS quantity, kit_row.position AS position
            FROM variant_components AS kit_row
            WHERE kit_row.kit_variant_id IN (SELECT own.id FROM product_variants AS own WHERE own.product_id = ${productId} AND own.deleted_at IS NULL))`).all(),
        db.select({ id: productVariants.id, sku: productVariants.sku, priceMinor: productVariants.priceMinor, discountType: productVariants.discountType, discountBps: productVariants.discountBps, discountAmountMinor: productVariants.discountAmountMinor })
            .from(productVariants)
            .where(and(eq(productVariants.productId, productId), isNull(productVariants.deletedAt),
                sql`EXISTS (SELECT 1 FROM variant_components AS own_kit WHERE own_kit.kit_variant_id = ${productVariants.id})`))
            .all(),
        readStoreCurrency(db),
    ]);
    if (!product) return null;
    const money = (minor: number) => fromMinor(minor, currency.decimalPlaces);
    const items = kitSkus.map((kitSku) => {
        const parts = rows.filter((row) => row.ownerId === kitSku.id).sort((a, b) => a.position - b.position);
        const priced = parts.map((part) => (editorProblem(part) === null ? storePriceMinor(part, currency.priceIncrementMinor) : 0));
        const kitOwnMinor = storePriceMinor({
            ...kitSku,
            productDiscountType: product.discountType,
            productDiscountBps: product.discountBps,
            productDiscountAmountMinor: product.discountAmountMinor,
        }, currency.priceIncrementMinor);
        const price = kitPrice(kitOwnMinor, parts.map((part, index) => ({ unitPriceMinor: priced[index]!, quantity: part.quantity })), currency.priceIncrementMinor);
        const unavailable = parts.flatMap((part) => {
            const problem = editorProblem(part);
            return problem ? [{ componentVariantId: part.variantId, reason: problem }] : [];
        });
        return {
            variantId: kitSku.id,
            sku: kitSku.sku,
            /** The kit SKU's own price (what a buyer pays, unless its items cost less together). */
            ownPrice: money(kitOwnMinor),
            price: money(price.priceMinor),
            compareAtPrice: money(price.compareAtMinor),
            saving: money(price.savingMinor),
            savingPercent: price.savingPercent,
            /** How many kits the items' stock allows; null when no item tracks stock. */
            availableQuantity: unavailable.length > 0 ? 0 : kitAvailableQuantity(parts.map((part) => ({
                available: Number(part.trackInventory) === 1 ? Number(part.stock ?? 0) - Number(part.reservedStock ?? 0) : null,
                quantity: part.quantity,
            }))),
            /** Why buyers can't buy it now (empty: they can, stock allowing). */
            unavailable,
            components: parts.map((part, index) => ({
                variantId: part.variantId,
                productId: part.productId,
                productName: part.productName,
                sku: part.sku,
                options: parseVariantOptionValues(part.options),
                quantity: part.quantity,
                price: part.priceMinor === null ? null : money(priced[index]!),
                stock: Number(part.trackInventory) === 1 ? Number(part.stock ?? 0) - Number(part.reservedStock ?? 0) : null,
                problem: editorProblem(part),
            })),
        };
    });
    return { section: "kits" as const, aggregateRevision: product.aggregateRevision, items };
}

/** The picker's page size bound, and how deep it pages (a search narrows past that). */
export const SKU_OPTIONS_LIMIT_MAX = 20;
export const SKU_OPTIONS_PAGE_MAX = 50;

/** The most SKUs one way of matching a search finds: as many as the picker pages through, and one more. */
const SKU_OPTIONS_MATCH_CAP = SKU_OPTIONS_LIMIT_MAX * SKU_OPTIONS_PAGE_MAX + 1;

/**
 * The ids of the SKUs a search finds, each way an index lookup bounded by
 * SKU_OPTIONS_MATCH_CAP: a word of its product's name or of its code (the
 * search index, as the product list searches), its exact barcode, or an
 * option value holding every word of the search (option values have no text
 * index: that way reads each option value once, never the SKUs). Undefined
 * when nothing in the search can match (no word and no barcode).
 */
function skuOptionMatches(db: Database, search: string): SQL | undefined {
    const key = sql.raw(searchKeyColumn(db));
    const cap = sql.raw(String(SKU_OPTIONS_MATCH_CAP));
    // A derived table per way: a compound member takes no LIMIT of its own on SQLite.
    const capped = (select: SQL) => sql`SELECT id FROM (${select} LIMIT ${cap}) AS sku_match`;
    const ways: SQL[] = [];
    const nameKeys = searchKeys(db, "products", search, { column: "name" });
    if (nameKeys) {
        ways.push(capped(sql`SELECT named_sku.id AS id FROM products AS named_product
            INNER JOIN product_variants AS named_sku ON named_sku.product_id = named_product.id
            WHERE named_product.${key} IN (${nameKeys}) AND named_sku.deleted_at IS NULL`));
    }
    const codeKeys = searchKeys(db, "product_variants", search);
    if (codeKeys) {
        ways.push(capped(sql`SELECT coded_sku.id AS id FROM product_variants AS coded_sku
            WHERE coded_sku.${key} IN (${codeKeys}) AND coded_sku.deleted_at IS NULL`));
    }
    const barcodeKey = getBarcodeIdentityKey(search);
    if (barcodeKey) {
        ways.push(sql`SELECT ${productVariants.id} AS id FROM ${productVariants}
            WHERE ${productVariantBarcodeIdentityEquals(barcodeKey)} AND ${productVariants.deletedAt} IS NULL`);
    }
    const words = sanitizeSearchTokens(search);
    if (words.length > 0) {
        ways.push(capped(sql`SELECT valued_sku.variant_id AS id FROM product_variant_option_values AS valued_sku
            WHERE valued_sku.option_value_id IN (SELECT matched_value.id FROM product_option_values AS matched_value
                WHERE matched_value.deleted_at IS NULL AND ${sql.join(words.map((word) => containsText(sql`matched_value.value`, word)), sql` AND `)}
                LIMIT ${cap})`));
    }
    return ways.length > 0 ? sql.join(ways, sql` UNION `) : undefined;
}

/**
 * Live SKUs of any product for the bundle and page-offer pickers, searched by
 * product name, SKU code, barcode or option value (`skuOptionMatches`); drafts
 * and untracked SKUs included (the editor shows their state), never a deleted
 * SKU or a SKU of a deleted product. Ordered by product name, product and SKU
 * id: the empty search walks the products' name index and stops after its
 * page; a search sorts only its matches. Each with its picture, options, price
 * in the store's currency, available units (null when it tracks none) and
 * whether it is a bundle (kit) or a gift card, which a bundle can't hold. Two
 * statements: the page's rows (its ids first, then the wide rows of those
 * ids), then their pictures.
 */
export async function searchProductSkuOptions(
    db: Database,
    input: { search?: string; page: number; limit: number },
) {
    const limit = Math.min(Math.max(1, Math.trunc(input.limit)), SKU_OPTIONS_LIMIT_MAX);
    const page = Math.min(Math.max(1, Math.trunc(input.page)), SKU_OPTIONS_PAGE_MAX);
    const term = input.search?.trim() ?? "";
    const matches = term === "" ? undefined : skuOptionMatches(db, term);
    const order = [products.name, products.id, productVariants.id];
    // A search drives from its matches: the unary `+` keeps SQLite off the
    // name index (`deleted_at` first), which would walk every product in order.
    const pageKeys = db.select({ id: productVariants.id }).from(productVariants)
        .innerJoin(products, eq(products.id, productVariants.productId))
        .where(term === ""
            ? and(isNull(productVariants.deletedAt), isNull(products.deletedAt))
            : and(sql`${productVariants.id} IN (${matches ?? sql`SELECT NULL WHERE 0 = 1`})`, isNull(productVariants.deletedAt), sql`+${products.deletedAt} IS NULL`))
        .orderBy(...order)
        .limit(limit + 1)
        .offset((page - 1) * limit);
    const [rows, currency] = await Promise.all([
        db.select({
            variantId: productVariants.id,
            productId: productVariants.productId,
            productName: products.name,
            productActive: products.isActive,
            giftCard: products.isGiftCard,
            sku: productVariants.sku,
            imageId: productVariants.imageId,
            priceMinor: productVariants.priceMinor,
            discountType: productVariants.discountType,
            discountBps: productVariants.discountBps,
            discountAmountMinor: productVariants.discountAmountMinor,
            productDiscountType: products.discountType,
            productDiscountBps: products.discountBps,
            productDiscountAmountMinor: products.discountAmountMinor,
            stock: productVariants.stock,
            reservedStock: productVariants.reservedStock,
            trackInventory: productVariants.trackInventory,
            options: variantOptionValuesSql(productVariants.id).as("pick_options"),
            isKit: sql<number>`EXISTS (SELECT 1 FROM variant_components AS pick_kit WHERE pick_kit.kit_variant_id = ${productVariants.id})`.mapWith(Number).as("pick_is_kit"),
        }).from(productVariants)
            .innerJoin(products, eq(products.id, productVariants.productId))
            .where(inArray(productVariants.id, pageKeys))
            .orderBy(...order)
            .all(),
        readStoreCurrency(db),
    ]);
    const shown = rows.slice(0, limit);
    const pictures = shown.length === 0 ? new Map<string, ProductMediaProjection[]>() : resolveProductMediaProjectionRows(await selectSkuMediaProjectionRows(db, {
        productIds: sql.join([...new Set(shown.map((row) => row.productId))].map((id) => sql`${id}`), sql`, `),
        variantIds: sql.join(shown.map((row) => sql`${row.variantId}`), sql`, `),
    }).all());
    const items = shown.map((row) => {
        const picture = resolveSkuImageRepresentation(pictures.get(row.productId) ?? [], row.imageId);
        return {
            variantId: row.variantId,
            productId: row.productId,
            productName: row.productName,
            productActive: row.productActive === true,
            sku: row.sku,
            options: parseVariantOptionValues(row.options),
            imageUrl: picture?.url ?? null,
            price: fromMinor(storePriceMinor(row, currency.priceIncrementMinor), currency.decimalPlaces),
            available: row.trackInventory ? Number(row.stock) - Number(row.reservedStock) : null,
            isKit: row.isKit === 1,
            isGiftCard: row.giftCard === true,
        };
    });
    return { items, page, hasMore: rows.length > limit && page < SKU_OPTIONS_PAGE_MAX };
}

/** The page's offers as the editor reads them: each placed SKU, whether buyers see it, and why not. */
export async function readProductPageOffersSection(db: Database, productId: string) {
    const [product, rows, currency] = await Promise.all([
        db.select({ aggregateRevision: products.aggregateRevision }).from(products).where(eq(products.id, productId)).get(),
        selectEditorSkuFacts(db, sql`(SELECT page_row.product_id AS owner_id, page_row.variant_id AS variant_id, 1 AS quantity, page_row.position AS position
            FROM product_page_offers AS page_row WHERE page_row.product_id = ${productId})`).all(),
        readStoreCurrency(db),
    ]);
    if (!product) return null;
    const items = [...rows].sort((a, b) => a.position - b.position).map((row) => {
        const problem = editorProblem(row);
        return {
            variantId: row.variantId,
            productId: row.productId,
            productName: row.productName,
            sku: row.sku,
            options: parseVariantOptionValues(row.options),
            position: row.position,
            isKit: Number(row.isKit) === 1,
            price: row.priceMinor === null ? null : fromMinor(storePriceMinor(row, currency.priceIncrementMinor), currency.decimalPlaces),
            /** Why buyers don't see it (null: they do, unless a kit's item can't be sold). */
            problem,
        };
    });
    return { section: "page_offers" as const, aggregateRevision: product.aggregateRevision, items };
}
