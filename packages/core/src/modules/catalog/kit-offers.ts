// A product page's kits and placed offers (migration 0224, products/kits.ts):
// what a kit SKU is made of, and the SKUs of other products the page shows
// under its own. Read in the page's second wave (two statements of its
// content batch, only when the product row says the page has any), priced
// by the one precedence in the page's market, banded, never exact stock.
import { sql, type SQL } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import { discountedPriceMinor, fromMinor } from "@scalius/shared/money";
import { resolveTrackedBuyerAvailabilityBand, type BuyerAvailabilityBand } from "@scalius/shared/buyer-availability";
import {
    channelOnHandSql,
    kitAvailableQuantity,
    kitComponentDeliverySql,
    kitComponentProblem,
    kitPrice,
    parseKitComponentDelivery,
    parseVariantOptionValues,
    productPublishedToChannelSql,
    resolveProductMediaProjectionRows,
    resolveSkuImageRepresentation,
    selectSkuMediaProjectionRows,
    storeDefaultLowStockThresholdSql,
    variantOptionValuesSql,
    type KitComponentDelivery,
    type ProductMediaProjectionRow,
} from "../products";
import {
    isNeutralMarketPricing,
    marketListPricesSql,
    parseMarketListPrices,
    resolvePublicSkuPrice,
    type MarketPriceContext,
    type MarketPricing,
} from "../price-lists";
import {
    applyTranslation,
    foldedProductChains,
    localizedSlugSql,
    productTranslationRowsSql,
    type TranslationScope,
} from "../translations";
import { deps } from "./declare-deps";
import { hasRequiredCustomization, parseStoredCustomizationSchema } from "@scalius/shared/line-properties";
import { STOREFRONT_PLACED_KIT_ITEMS_MAX } from "@scalius/shared/plugins/storefront-protocol";

/**
 * The items a placed offer's kit lists on its host page, at most: a summary
 * (`componentCount` says how many it holds), the full list being on the
 * kit's own page, so twenty placed twenty-item kits stay inside a page's and
 * a theme's render bounds.
 */
export const PLACED_KIT_ITEMS_MAX = STOREFRONT_PLACED_KIT_ITEMS_MAX;

/** Whether a product page has kits or placed offers (a column of the page's product row). */
export function productPageHasKitsSql(productId: SQL): SQL<number> {
    return sql<number>`(EXISTS (SELECT 1 FROM product_page_offers AS has_offer WHERE has_offer.product_id = ${productId})
        OR EXISTS (SELECT 1 FROM variant_components AS has_kit
            INNER JOIN product_variants AS has_kit_sku ON has_kit_sku.id = has_kit.kit_variant_id
            WHERE has_kit_sku.product_id = ${productId} AND has_kit_sku.deleted_at IS NULL))`;
}

/** The SKUs a page shows besides its own: its placed offers and every component of its kits and theirs. */
function pageSkuSourceSql(productId: string): SQL {
    return sql`(
        SELECT 'offer' AS role, NULL AS kit_variant_id, page_offer.variant_id AS variant_id, page_offer.position AS position, 1 AS quantity
        FROM product_page_offers AS page_offer WHERE page_offer.product_id = ${productId}
        UNION ALL
        SELECT 'component' AS role, page_kit.kit_variant_id AS kit_variant_id, page_kit.component_variant_id AS variant_id, page_kit.position AS position, page_kit.quantity AS quantity
        FROM variant_components AS page_kit
        WHERE page_kit.kit_variant_id IN (
            SELECT own_sku.id FROM product_variants AS own_sku WHERE own_sku.product_id = ${productId} AND own_sku.deleted_at IS NULL
            UNION SELECT placed.variant_id FROM product_page_offers AS placed WHERE placed.product_id = ${productId}
        )
    )`;
}

function pageSkuIdsSql(productId: string): SQL {
    return sql`SELECT page_sku_id.variant_id FROM ${pageSkuSourceSql(productId)} AS page_sku_id`;
}

/** The page's kit and placed-offer SKU rows (each with its product), in one statement. */
export function selectProductPageKitRows(db: Database, productId: string, pricing: MarketPricing | null, translation: TranslationScope | null) {
    const variantId = sql`page_variant.id`;
    const product = sql`page_product.id`;
    return db.select({
        role: sql<string>`page_sku.role`.as("pk_role"),
        kitVariantId: sql<string | null>`page_sku.kit_variant_id`.as("pk_kit_variant_id"),
        variantId: sql<string>`page_sku.variant_id`.as("pk_variant_id"),
        position: sql<number>`page_sku.position`.mapWith(Number).as("pk_position"),
        quantity: sql<number>`page_sku.quantity`.mapWith(Number).as("pk_quantity"),
        variantLive: sql<number>`page_variant.id IS NOT NULL`.mapWith(Number).as("pk_variant_live"),
        productId: sql<string | null>`page_product.id`.as("pk_product_id"),
        productName: sql<string | null>`page_product.name`.as("pk_product_name"),
        productSlug: sql<string | null>`page_product.slug`.as("pk_product_slug"),
        productActive: sql<number | null>`page_product.is_active`.as("pk_product_active"),
        productDeleted: sql<number | null>`page_product.deleted_at IS NOT NULL`.as("pk_product_deleted"),
        productGiftCard: sql<number | null>`page_product.is_gift_card`.as("pk_product_gift_card"),
        productCustomization: sql<string | null>`page_product.customization_schema`.as("pk_product_customization"),
        productPublished: sql<number | null>`${productPublishedToChannelSql(product)}`.as("pk_product_published"),
        productPriceMinor: sql<number | null>`page_product.price_minor`.as("pk_product_price_minor"),
        productDiscountType: sql<string | null>`page_product.discount_type`.as("pk_product_discount_type"),
        productDiscountBps: sql<number | null>`page_product.discount_bps`.as("pk_product_discount_bps"),
        productDiscountAmountMinor: sql<number | null>`page_product.discount_amount_minor`.as("pk_product_discount_amount_minor"),
        sku: sql<string | null>`page_variant.sku`.as("pk_sku"),
        isDefault: sql<number | null>`page_variant.is_default`.as("pk_is_default"),
        priceMinor: sql<number | null>`page_variant.price_minor`.as("pk_price_minor"),
        discountType: sql<string | null>`page_variant.discount_type`.as("pk_discount_type"),
        discountBps: sql<number | null>`page_variant.discount_bps`.as("pk_discount_bps"),
        discountAmountMinor: sql<number | null>`page_variant.discount_amount_minor`.as("pk_discount_amount_minor"),
        stock: sql<number | null>`${channelOnHandSql({ id: variantId, stock: sql`page_variant.stock` })}`.as("pk_stock"),
        reservedStock: sql<number | null>`page_variant.reserved_stock`.as("pk_reserved_stock"),
        trackInventory: sql<number | null>`page_variant.track_inventory`.as("pk_track_inventory"),
        lowStockThreshold: sql<number | null>`COALESCE(page_variant.low_stock_threshold, ${storeDefaultLowStockThresholdSql()})`.as("pk_low_stock_threshold"),
        imageId: sql<string | null>`page_variant.image_id`.as("pk_image_id"),
        fulfillmentKind: sql<string | null>`page_variant.fulfillment_kind`.as("pk_fulfillment_kind"),
        delivery: kitComponentDeliverySql({ id: variantId, fulfillmentKind: sql`page_variant.fulfillment_kind` }).as("pk_delivery"),
        options: variantOptionValuesSql(variantId).as("pk_options"),
        // The placed SKU is itself a kit (its components are rows of this statement).
        isKit: sql<number>`EXISTS (SELECT 1 FROM variant_components AS placed_kit WHERE placed_kit.kit_variant_id = page_sku.variant_id)`.as("pk_is_kit"),
        ...(pricing ? { listPrices: marketListPricesSql(variantId, { presence: pricing.presence }).as("pk_list_prices") } : {}),
        ...(translation ? {
            // The item's product and its options and values, in the page's language.
            trRows: productTranslationRowsSql(translation, product).as("pk_tr_rows"),
            trSlug: localizedSlugSql(translation, "product", product).as("pk_tr_slug"),
        } : {}),
    }).from(sql`${pageSkuSourceSql(productId)} AS page_sku
        LEFT JOIN product_variants AS page_variant ON page_variant.id = page_sku.variant_id AND page_variant.deleted_at IS NULL
        LEFT JOIN products AS page_product ON page_product.id = page_variant.product_id`);
}

/** The pictures of those SKUs (each SKU's image, else its product's), in one statement. */
export function selectProductPageKitMediaRows(db: Database, productId: string) {
    return selectSkuMediaProjectionRows(db, {
        productIds: sql`SELECT page_media_sku.product_id FROM product_variants AS page_media_sku WHERE page_media_sku.id IN (${pageSkuIdsSql(productId)})`,
        variantIds: pageSkuIdsSql(productId),
    });
}

export type ProductPageKitRow = Awaited<ReturnType<ReturnType<typeof selectProductPageKitRows>["all"]>>[number] & {
    listPrices?: string | null;
    trRows?: string | null;
    trSlug?: string | null;
};

/** A SKU row as the page prices it: its price and discount, its product's discount, its market list prices. */
interface PricedSkuRow {
    productId: string | null;
    priceMinor: number | null;
    discountType: string | null;
    discountBps: number | null;
    discountAmountMinor: number | null;
    productDiscountType: string | null;
    productDiscountBps: number | null;
    productDiscountAmountMinor: number | null;
    listPrices?: string | null;
}

/**
 * A SKU's buyer price in the page's market, by the one precedence: its own
 * discount, else its product's, at the store's increment; then the market's
 * lists and conversion (`resolvePublicSkuPrice`), exactly as checkout prices
 * one unit.
 */
export function pageSkuBuyerMinor(row: PricedSkuRow, market: MarketPriceContext | null, storeIncrementMinor: number): number {
    return pageSkuBuyerPrice(row, market, storeIncrementMinor).amountMinor;
}

/** A SKU's buyer price and, while it is on sale, its regular price (the struck one), both in the page's market. */
export function pageSkuBuyerPrice(row: PricedSkuRow, market: MarketPriceContext | null, storeIncrementMinor: number): { amountMinor: number; compareAtMinor: number | null } {
    const priceMinor = Number(row.priceMinor ?? 0);
    const own = (row.discountType === "percentage" && Number(row.discountBps) > 0) || (row.discountType === "flat" && Number(row.discountAmountMinor) > 0);
    const effectiveMinor = own
        ? discountedPriceMinor(priceMinor, row.discountType, Number(row.discountBps ?? 0), Number(row.discountAmountMinor ?? 0), storeIncrementMinor)
        : discountedPriceMinor(priceMinor, row.productDiscountType, Number(row.productDiscountBps ?? 0), Number(row.productDiscountAmountMinor ?? 0), storeIncrementMinor);
    if (!market || isNeutralMarketPricing(market)) return { amountMinor: effectiveMinor, compareAtMinor: priceMinor > effectiveMinor ? priceMinor : null };
    const resolved = resolvePublicSkuPrice(market, { priceMinor, effectiveMinor }, parseMarketListPrices(row.listPrices));
    return { amountMinor: resolved.amountMinor, compareAtMinor: resolved.compareAtMinor };
}

/** One included item of a kit as a buyer reads it. */
export interface StorefrontKitComponent {
    variantId: string;
    productId: string;
    /** In the page's language. */
    productName: string;
    /** Its product's page (in the page's language); null when that page is not public. */
    productSlug: string | null;
    imageUrl: string | null;
    imageMediaId: string | null;
    imageAlt: string | null;
    /** The chosen option values (platform, format), in option order. */
    options: Array<{ name: string; value: string }>;
    quantity: number;
    /** How it reaches the buyer, from its own fulfilment setting: the theme words it. */
    delivery: KitComponentDelivery;
    /** One unit's price in the page's currency. */
    price: number;
}

/** A kit as a buyer reads it: its contents, its price against them, and a band. */
export interface StorefrontKit {
    /**
     * Its items a buyer may read, in order: none whose product is a draft,
     * archived or deleted (counted in `unavailableItems`); on a host page's
     * placed offer the first `PLACED_KIT_ITEMS_MAX`.
     */
    components: StorefrontKitComponent[];
    /** How many items it holds, whatever `components` lists. */
    componentCount: number;
    /** Items withheld because their product is not for sale (the kit is out of stock then). */
    unavailableItems: number;
    /** What one kit costs (its own price, never more than `compareAtPrice`). */
    price: number;
    /** Its components at their current prices. */
    compareAtPrice: number;
    saving: number;
    savingPercent: number;
    /** From its components (`kitAvailableQuantity`); `out_of_stock` when a component can't be sold. */
    availabilityBand: BuyerAvailabilityBand;
}

/** A SKU of another product shown under the page's own offers. */
export interface StorefrontPlacedOffer {
    variantId: string;
    productId: string;
    productName: string;
    productSlug: string;
    sku: string;
    options: Array<{ name: string; value: string }>;
    imageUrl: string | null;
    imageMediaId: string | null;
    imageAlt: string | null;
    fulfillmentKind: string;
    /** One unit's price in the page's currency (a kit's: its own price). */
    price: number;
    /** A kit's components summed, or a SKU's regular price while it is on sale; null otherwise. */
    compareAtPrice: number | null;
    /** Its product asks the buyer for inputs before buying: offer it as a link to its page, never a bare add. */
    requiresCustomization: boolean;
    availabilityBand: BuyerAvailabilityBand;
    /** Its contents when it is a kit; null otherwise. */
    kit: StorefrontKit | null;
}

/**
 * The page's kits (by kit SKU id) and placed offers (in order) from the two
 * statements. `ownKitPrices` are the page's own kit SKUs' buyer prices. A
 * placed offer whose SKU or product can't be sold (deleted, a draft,
 * unpublished) is left out, and so is a placed kit with such a component
 * and any placed offer out of stock (a kit's scarcest item gone); a kit of
 * the page's own with one reads `out_of_stock`.
 */
export function resolveProductPageKits(
    rows: readonly ProductPageKitRow[],
    mediaRows: readonly ProductMediaProjectionRow[],
    context: {
        market: MarketPriceContext | null;
        storeIncrementMinor: number;
        decimalPlaces: number;
        translation: TranslationScope | null;
        ownKitPrices: ReadonlyMap<string, { priceMinor: number; lowStockThreshold: number | null }>;
    },
): { kits: Map<string, StorefrontKit>; placedOffers: StorefrontPlacedOffer[] } {
    const media = resolveProductMediaProjectionRows(mediaRows);
    const incrementMinor = context.market?.incrementMinor ?? context.storeIncrementMinor;
    const money = (minor: number) => fromMinor(minor, context.decimalPlaces);
    // Every product a kit or offer shows: its price, band, status and pictures reach this page.
    for (const row of rows) if (row.productId) deps.product(row.productId);
    const chainsOf = (row: ProductPageKitRow) => context.translation && row.trRows !== undefined
        ? foldedProductChains(context.translation, row.trRows)
        : null;
    const named = (row: ProductPageKitRow) => {
        const source = { name: row.productName ?? "", slug: row.productSlug ?? "" };
        const chains = chainsOf(row);
        return chains && row.productId
            ? applyTranslation(source, chains.get(`product:${row.productId}`) ?? [], { name: "name" }, row.trSlug ?? null)
            : source;
    };
    // Option names and values in the page's language (the item's product's own translations).
    const optionsOf = (row: ProductPageKitRow) => {
        const chains = chainsOf(row);
        return parseVariantOptionValues(row.options, chains ? {
            option: (id, name) => applyTranslation({ name }, chains.get(`product_option:${id}`) ?? [], { name: "name" }).name,
            value: (id, text) => applyTranslation({ value: text }, chains.get(`product_option_value:${id}`) ?? [], { value: "value" }).value,
        } : undefined);
    };
    const image = (row: ProductPageKitRow) => row.productId ? resolveSkuImageRepresentation(media.get(row.productId) ?? [], row.imageId) : null;
    const sellable = (row: ProductPageKitRow) => kitComponentProblem({
        variantLive: Number(row.variantLive) === 1,
        productActive: row.productActive === null ? null : Number(row.productActive) === 1,
        productDeleted: row.productDeleted === null ? null : Number(row.productDeleted) === 1,
        productPublished: row.productPublished === null ? null : Number(row.productPublished) === 1,
        productGiftCard: row.productGiftCard === null ? null : Number(row.productGiftCard) === 1,
    }) === null;
    const available = (row: ProductPageKitRow): number | null => Number(row.trackInventory) === 1
        ? Math.max(0, Number(row.stock ?? 0) - Number(row.reservedStock ?? 0))
        : null;
    const buyerMinor = (row: ProductPageKitRow) => pageSkuBuyerMinor(row, context.market, context.storeIncrementMinor);

    const componentsByKit = new Map<string, ProductPageKitRow[]>();
    for (const row of rows) {
        if (row.role !== "component" || !row.kitVariantId) continue;
        const list = componentsByKit.get(row.kitVariantId) ?? [];
        list.push(row);
        componentsByKit.set(row.kitVariantId, list);
    }
    // An item whose product is a draft, archived, deleted or a gift card is never named or pictured; an unpublished one is, without a link.
    const withheld = (row: ProductPageKitRow) => {
        const problem = kitComponentProblem({
            variantLive: Number(row.variantLive) === 1,
            productActive: row.productActive === null ? null : Number(row.productActive) === 1,
            productDeleted: row.productDeleted === null ? null : Number(row.productDeleted) === 1,
            productPublished: row.productPublished === null ? null : Number(row.productPublished) === 1,
            productGiftCard: row.productGiftCard === null ? null : Number(row.productGiftCard) === 1,
        });
        return problem !== null && problem !== "component_unpublished";
    };
    const kitOf = (kitVariantId: string, kitPriceMinor: number, lowStockThreshold: number | null, listed = Number.POSITIVE_INFINITY): { kit: StorefrontKit; sellable: boolean } | null => {
        const parts = (componentsByKit.get(kitVariantId) ?? []).sort((a, b) => a.position - b.position || a.variantId.localeCompare(b.variantId));
        if (parts.length === 0) return null;
        const allSellable = parts.every(sellable);
        const prices = parts.map((part) => (sellable(part) ? buyerMinor(part) : 0));
        const price = kitPrice(kitPriceMinor, parts.map((part, index) => ({ unitPriceMinor: prices[index]!, quantity: part.quantity })), incrementMinor);
        const count = kitAvailableQuantity(parts.map((part) => ({ available: available(part), quantity: part.quantity })));
        const availabilityBand: BuyerAvailabilityBand = !allSellable
            ? "out_of_stock"
            : count === null ? "untracked" : resolveTrackedBuyerAvailabilityBand(count, lowStockThreshold);
        const components = parts.flatMap((part, index): StorefrontKitComponent[] => {
            if (!part.productId || withheld(part)) return [];
            const picture = image(part);
            const name = named(part);
            return [{
                variantId: part.variantId,
                productId: part.productId,
                productName: name.name,
                productSlug: sellable(part) ? name.slug || null : null,
                imageUrl: picture?.url ?? null,
                imageMediaId: picture?.mediaId ?? null,
                imageAlt: picture?.altText ?? null,
                options: optionsOf(part),
                quantity: part.quantity,
                delivery: parseKitComponentDelivery(part.delivery),
                price: money(prices[index]!),
            }];
        });
        return {
            sellable: allSellable,
            kit: {
                components: components.slice(0, listed),
                componentCount: parts.length,
                unavailableItems: parts.filter((part) => !part.productId || withheld(part)).length,
                price: money(price.priceMinor),
                compareAtPrice: money(price.compareAtMinor),
                saving: money(price.savingMinor),
                savingPercent: price.savingPercent,
                availabilityBand,
            },
        };
    };

    const kits = new Map<string, StorefrontKit>();
    for (const [kitVariantId, own] of context.ownKitPrices) {
        const read = kitOf(kitVariantId, own.priceMinor, own.lowStockThreshold);
        if (read) kits.set(kitVariantId, read.kit);
    }

    const placedOffers: StorefrontPlacedOffer[] = [];
    for (const row of [...rows].filter((candidate) => candidate.role === "offer").sort((a, b) => a.position - b.position)) {
        if (!row.productId || !sellable(row)) continue;
        const unit = pageSkuBuyerPrice(row, context.market, context.storeIncrementMinor);
        const unitMinor = unit.amountMinor;
        const threshold = row.lowStockThreshold === null ? null : Number(row.lowStockThreshold);
        // A host page lists a placed kit's first items; its own page lists them all.
        const kit = Number(row.isKit) === 1 ? kitOf(row.variantId, unitMinor, threshold, PLACED_KIT_ITEMS_MAX) : null;
        // A placed kit with a component that can't be sold is not offered.
        if (Number(row.isKit) === 1 && (!kit || !kit.sellable)) continue;
        const own = available(row);
        const availabilityBand: BuyerAvailabilityBand = kit
            ? kit.kit.availabilityBand
            : own === null ? "untracked" : resolveTrackedBuyerAvailabilityBand(own, threshold);
        // Nor is one that can't be bought now (a kit whose scarcest item is gone): the host offers what sells.
        if (availabilityBand === "out_of_stock") continue;
        const picture = image(row);
        const name = named(row);
        placedOffers.push({
            variantId: row.variantId,
            productId: row.productId,
            productName: name.name,
            productSlug: name.slug,
            sku: row.sku ?? "",
            options: optionsOf(row),
            imageUrl: picture?.url ?? null,
            imageMediaId: picture?.mediaId ?? null,
            imageAlt: picture?.altText ?? null,
            fulfillmentKind: row.fulfillmentKind ?? "physical",
            price: kit ? kit.kit.price : money(unitMinor),
            compareAtPrice: kit ? kit.kit.compareAtPrice : unit.compareAtMinor !== null ? money(unit.compareAtMinor) : null,
            requiresCustomization: requiresBuyerInput(row.productCustomization),
            availabilityBand,
            kit: kit?.kit ?? null,
        });
    }
    return { kits, placedOffers };
}

/** A product's stored buyer inputs ask for an answer (an unreadable set asks too: its page says why). */
function requiresBuyerInput(stored: string | null | undefined): boolean {
    if (!stored) return false;
    const parsed = parseStoredCustomizationSchema(stored);
    return !parsed.ok || hasRequiredCustomization(parsed.schema);
}
