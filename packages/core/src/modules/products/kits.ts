// Kits (migration 0224): a SKU made of other SKUs. A kit is an ordinary SKU
// of an ordinary product, so its title, price (one precedence,
// `resolvePrice()`), price lists, markets, status, translations and URL are
// the catalogue's. What a kit adds:
//
// - Components: 1 to `KIT_COMPONENTS_MAX` SKUs of any products, each with a
//   quantity (`variant_components`; guard triggers refuse an illegal kit).
// - No stock of its own: it is available while every component is, as many
//   as the scarcest component allows (its available units over its quantity).
// - Price: the kit's own price is what the buyer pays, on every surface. It
//   is split over the components in proportion to their prices (`kitPrice`):
//   each component line is charged its exact share, a price like any other,
//   so promotions, tax and delivery thresholds read what is charged. The
//   compare-at (the components' current prices summed) and the saving are
//   display only, computed on read.
//
// Checkout sells a kit as its components through `cart.transform` expand
// (checkout/cart-transform.ts): rules/catalog/kits-sell-as-components.md.
import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { allocateProportionalMinor } from "@scalius/shared/money-allocation";
import { KIT_COMPONENTS_MAX, KIT_COMPONENT_QUANTITY_MAX, PRODUCT_PAGE_OFFERS_MAX } from "@scalius/database/schema";

export { KIT_COMPONENTS_MAX, KIT_COMPONENT_QUANTITY_MAX, PRODUCT_PAGE_OFFERS_MAX };

/** One component of a kit as checkout reads it; `productId` null: its SKU is gone. */
export interface KitComponentRef {
    variantId: string;
    productId: string | null;
    quantity: number;
}

/**
 * A SKU's components as one JSON text (null for a SKU that is not a kit), in
 * the kit's order, on the row that reads the SKU: checkout learns a cart line
 * is a kit, and what it is made of, in the statement it already runs.
 */
export function kitComponentsSql(variantId: SQLWrapper): SQL<string | null> {
    return sql<string | null>`(SELECT '[' || group_concat(json_object(
        'v', kit_part.component_variant_id,
        'p', kit_part.product_id,
        'q', CAST(kit_part.quantity AS TEXT),
        'o', CAST(kit_part.position AS TEXT)
    ), ',') || ']'
    FROM (
        SELECT kit_row.component_variant_id, kit_sku.product_id, kit_row.quantity, kit_row.position
        FROM variant_components AS kit_row
        LEFT JOIN product_variants AS kit_sku ON kit_sku.id = kit_row.component_variant_id AND kit_sku.deleted_at IS NULL
        WHERE kit_row.kit_variant_id = ${variantId}
        ORDER BY kit_row.position, kit_row.component_variant_id
    ) AS kit_part)`;
}

/** The SQL of `kitComponentsSql`, parsed; null for a SKU that is not a kit (or a malformed value). */
export function parseKitComponents(value: unknown): KitComponentRef[] | null {
    if (typeof value !== "string" || value === "") return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(value);
    } catch {
        return null;
    }
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const components: Array<KitComponentRef & { position: number }> = [];
    for (const entry of parsed as Array<{ v?: unknown; p?: unknown; q?: unknown; o?: unknown }>) {
        const quantity = Number(entry.q);
        if (typeof entry.v !== "string" || !Number.isSafeInteger(quantity) || quantity < 1) return null;
        components.push({ variantId: entry.v, productId: typeof entry.p === "string" ? entry.p : null, quantity, position: Number(entry.o) || 0 });
    }
    // The kit's order on every provider (an aggregate's order is not guaranteed everywhere).
    return components
        .sort((left, right) => left.position - right.position || left.variantId.localeCompare(right.variantId))
        .map(({ position: _position, ...component }) => component);
}

/** A kit's money in one currency: its price, its components' summed prices and the saving. */
export interface KitPrice {
    /** What one kit costs the buyer: the kit SKU's own price, everywhere (page, cards, cart, order). */
    priceMinor: number;
    /** Every component at its current price times its quantity (display only). */
    compareAtMinor: number;
    /** `compareAtMinor - priceMinor` when the kit costs less than its parts, else 0 (display only). */
    savingMinor: number;
    /** The saving as a whole percent of the compare-at (0 without one). */
    savingPercent: number;
    /**
     * Each component's unit price in the kit, in component order: the kit's
     * price split over its items by their prices, in whole increments, so
     * `sum(unit × quantity)` is exactly `priceMinor`. This is what checkout
     * charges each component line; every reader of a price reads it.
     */
    componentUnitPricesMinor: number[];
}

/** A kit needs one item it holds once: that item takes what the others' whole per-unit prices leave. */
export class KitWithoutSingleItemError extends Error {
    constructor() {
        super("A kit needs at least one item it holds once.");
        this.name = "KitWithoutSingleItemError";
    }
}

/**
 * One kit's price from its own price (resolved by the one precedence) and its
 * components' current prices, all in one currency. The kit's price is split
 * over the items in proportion to their prices (`allocateProportionalMinor`,
 * stable order for ties): each item held several times per kit takes a whole
 * per-unit price, and what that leaves goes to the dearest item held once,
 * so the split is exact. Throws `KitWithoutSingleItemError` when no item is
 * held once (the editor refuses such a kit).
 */
export function kitPrice(
    kitPriceMinor: number,
    components: ReadonlyArray<{ unitPriceMinor: number; quantity: number }>,
    /** The currency's price increment. */
    incrementMinor: number,
): KitPrice {
    const compareAtMinor = components.reduce((total, component) => total + component.unitPriceMinor * component.quantity, 0);
    const priceMinor = kitPriceMinor;
    const savingMinor = Math.max(0, compareAtMinor - priceMinor);
    const single = components.reduce<number>((best, component, index) =>
        component.quantity !== 1 ? best : best < 0 || component.unitPriceMinor > components[best]!.unitPriceMinor ? index : best, -1);
    if (components.length > 0 && single < 0) throw new KitWithoutSingleItemError();
    const unit = priceMinor % incrementMinor === 0 && components.every((component) => component.unitPriceMinor % incrementMinor === 0) ? incrementMinor : 1;
    const weights = components.map((component) => BigInt(component.unitPriceMinor) * BigInt(component.quantity));
    const totals = components.length === 0 ? [] : allocateProportionalMinor(
        priceMinor / unit,
        weights.some((weight) => weight > 0n) ? weights : components.map((component) => BigInt(component.quantity)),
    );
    let leftover = 0;
    const units = totals.map((total, index) => {
        const quantity = components[index]!.quantity;
        if (quantity === 1) return total;
        const each = Math.floor(total / quantity);
        leftover += total - each * quantity;
        return each;
    });
    if (single >= 0) units[single]! += leftover;
    return {
        priceMinor,
        compareAtMinor,
        savingMinor,
        savingPercent: compareAtMinor > 0 && savingMinor > 0 ? Math.round((savingMinor * 100) / compareAtMinor) : 0,
        componentUnitPricesMinor: units.map((count) => count * unit),
    };
}

/**
 * How many kits the components allow: each tracked component's available
 * units over its quantity, the least of them; null when no component is
 * tracked (the kit is untracked too).
 */
export function kitAvailableQuantity(components: ReadonlyArray<{ available: number | null; quantity: number }>): number | null {
    let least: number | null = null;
    for (const component of components) {
        if (component.available === null) continue;
        const kits = Math.floor(Math.max(0, component.available) / component.quantity);
        least = least === null ? kits : Math.min(least, kits);
    }
    return least;
}

/** Why a kit cannot be sold right now (the merchant read says it; buyers see it unavailable). */
export const KIT_COMPONENT_PROBLEMS = [
    /** The component SKU was deleted. */
    "component_deleted",
    /** Its product is a draft or archived (not active). */
    "component_inactive",
    /** Its product was deleted. */
    "component_product_deleted",
    /** Its product is not published to the online store. */
    "component_unpublished",
    /** Its product is a gift card (refused on write; a product turned into one later). */
    "component_gift_card",
] as const;
export type KitComponentProblem = (typeof KIT_COMPONENT_PROBLEMS)[number];

/** A component's problem from its SKU and product facts; null when it can be sold. */
export function kitComponentProblem(component: {
    variantLive: boolean;
    productActive: boolean | null;
    productDeleted: boolean | null;
    productPublished: boolean | null;
    productGiftCard: boolean | null;
}): KitComponentProblem | null {
    if (!component.variantLive) return "component_deleted";
    if (component.productDeleted) return "component_product_deleted";
    if (component.productGiftCard) return "component_gift_card";
    if (!component.productActive) return "component_inactive";
    if (component.productPublished === false) return "component_unpublished";
    return null;
}

/** How a component reaches the buyer, from its own fulfilment setting (never retyped per kit). */
export type KitComponentDelivery = "physical" | "service" | "digital_key" | "digital_file";

/**
 * The delivery of a SKU as SQL: its fulfilment kind, and for a digital SKU
 * whether a ready licence-key pool (a key) or a file delivers it.
 */
export function kitComponentDeliverySql(variant: { id: SQL; fulfillmentKind: SQL }): SQL<string | null> {
    return sql<string | null>`CASE WHEN ${variant.fulfillmentKind} = 'digital' THEN (CASE WHEN EXISTS (
            SELECT 1 FROM digital_assets AS kit_key_pool
            WHERE kit_key_pool.variant_id = ${variant.id} AND kit_key_pool.kind = 'licence_keys' AND kit_key_pool.status = 'ready'
        ) THEN 'digital_key' ELSE 'digital_file' END) ELSE ${variant.fulfillmentKind} END`;
}

export function parseKitComponentDelivery(value: unknown): KitComponentDelivery {
    return value === "service" || value === "digital_key" || value === "digital_file" ? value : "physical";
}

/** A SKU's chosen option values (`[{ name, value }]`, in option order) as one JSON text. */
export function variantOptionValuesSql(variantId: SQLWrapper): SQL<string | null> {
    return sql<string | null>`(SELECT '[' || group_concat(json_object('n', kit_option.name, 'v', kit_option.value), ',') || ']'
        FROM (
            SELECT pod.name AS name, pov.value AS value
            FROM product_variant_option_values AS pvov
            JOIN product_option_definitions AS pod ON pod.id = pvov.option_definition_id
            JOIN product_option_values AS pov ON pov.id = pvov.option_value_id
            WHERE pvov.variant_id = ${variantId}
            ORDER BY pod.position
        ) AS kit_option)`;
}

export function parseVariantOptionValues(value: unknown): Array<{ name: string; value: string }> {
    if (typeof value !== "string" || value === "") return [];
    try {
        const parsed = JSON.parse(value) as unknown;
        if (!Array.isArray(parsed)) return [];
        return parsed.flatMap((entry: { n?: unknown; v?: unknown }) =>
            typeof entry.n === "string" && typeof entry.v === "string" ? [{ name: entry.n, value: entry.v }] : []);
    } catch {
        return [];
    }
}

/**
 * Why a kit or a page's offers can't be saved (`details.reason`), with words
 * a merchant reads and an agent can act on: each says what is allowed.
 */
export const KIT_REFUSALS = {
    kit_component_limit: `A kit holds at most ${KIT_COMPONENTS_MAX} different items. Remove one, or sell the rest as another kit.`,
    kit_component_duplicate: "An item is in this kit twice. Keep it once and set its quantity instead.",
    kit_component_self: "A kit can't contain itself. Choose items of other SKUs.",
    kit_component_missing: "An item you chose is no longer sold (it was deleted). Choose a live SKU.",
    kit_component_gift_card: "A gift card can't be part of a kit. Sell it on its own.",
    kit_component_nested: "A kit can't contain another kit. Add that kit's items instead.",
    kit_is_component: "This SKU is part of another kit, so it can't be a kit itself. Remove it from that kit first.",
    kit_gift_card: "A gift card can't be a kit.",
    kit_has_stock: "A kit has no stock of its own: its items carry it. Set this SKU's stock to 0 first.",
    kit_stock_movement: "This SKU is a kit, so its stock comes from its items. Change the items' stock instead.",
    kit_variant_not_found: "That SKU is not a live SKU of this product.",
    page_offer_limit: `A product page shows at most ${PRODUCT_PAGE_OFFERS_MAX} offers of other products.`,
    page_offer_duplicate: "An offer is listed twice. Keep it once.",
    page_offer_missing: "An offer you chose is no longer sold (it was deleted). Choose a live SKU.",
    page_offer_own_sku: "This product's own SKUs already show on its page. Choose SKUs of other products.",
} as const;
export type KitRefusalReason = keyof typeof KIT_REFUSALS;

/** A refusal with its reason (and the SKU it is about, when one). */
export function kitRefusal(reason: KitRefusalReason, extra: { field?: string; variantId?: string } = {}) {
    return { message: KIT_REFUSALS[reason], details: { reason, field: extra.field ?? "components", ...(extra.variantId ? { variantId: extra.variantId } : {}) } };
}

/** The guard trigger messages of migration 0224, by the refusal each stands for. */
const KIT_GUARD_REASONS: ReadonlyArray<[string, KitRefusalReason]> = [
    ["variant_components_component_missing", "kit_component_missing"],
    ["variant_components_nested", "kit_component_nested"],
    ["variant_components_gift_card", "kit_component_gift_card"],
    ["variant_components_limit", "kit_component_limit"],
    ["variant_components_kit_stock", "kit_has_stock"],
    ["variant_components_not_self", "kit_component_self"],
    ["inventory_movements_kit", "kit_stock_movement"],
    ["product_page_offers_variant_invalid", "page_offer_own_sku"],
    ["product_page_offers_limit", "page_offer_limit"],
];

function errorText(error: unknown, depth = 0): string {
    if (depth > 3 || error === null || error === undefined) return "";
    if (error instanceof Error) return `${error.message} ${errorText((error as Error & { cause?: unknown }).cause, depth + 1)}`;
    return typeof error === "string" ? error : "";
}

/** The refusal a 0224 guard trigger raised (a write that raced the checks before it), or null. */
export function kitGuardRefusal(error: unknown): ReturnType<typeof kitRefusal> | null {
    const text = errorText(error);
    const match = KIT_GUARD_REASONS.find(([marker]) => text.includes(marker));
    return match ? kitRefusal(match[1], { field: match[1] === "kit_stock_movement" ? "stock" : match[1].startsWith("page_offer") ? "variantIds" : "components" }) : null;
}
