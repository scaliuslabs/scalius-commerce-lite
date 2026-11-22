// Kits (migration 0224): a SKU made of other SKUs. A kit is an ordinary SKU
// of an ordinary product, so its title, price (one precedence,
// `resolvePrice()`), price lists, markets, status, translations and URL are
// the catalogue's. What a kit adds:
//
// - Components: 1 to `KIT_COMPONENTS_MAX` SKUs of any products, each with a
//   quantity (`variant_components`; guard triggers refuse an illegal kit).
// - No stock of its own: it is available while every component is, as many
//   as the scarcest component allows (its available units over its quantity).
// - Price: the kit's own price is what the buyer pays, never more than its
//   components bought one by one; the compare-at is the components' current
//   prices summed, computed on read, and the saving is the difference. The
//   split over the components is `bundleGroupPricing`'s fixed-price set (one
//   set: one kit), so it conserves exactly and no component's share passes its
//   price (rules/money/bundle-components-conserved.md).
//
// Checkout sells a kit as its components through `cart.transform` expand
// (checkout/cart-transform.ts): rules/catalog/kits-sell-as-components.md.
import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { bundleGroupPricing } from "@scalius/shared/product-bundles";
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
        'q', CAST(kit_part.quantity AS TEXT)
    ), ',') || ']'
    FROM (
        SELECT kit_row.component_variant_id, kit_sku.product_id, kit_row.quantity
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
    const components: KitComponentRef[] = [];
    for (const entry of parsed as Array<{ v?: unknown; p?: unknown; q?: unknown }>) {
        const quantity = Number(entry.q);
        if (typeof entry.v !== "string" || !Number.isSafeInteger(quantity) || quantity < 1) return null;
        components.push({ variantId: entry.v, productId: typeof entry.p === "string" ? entry.p : null, quantity });
    }
    return components;
}

/** A kit's money in one currency: its price, its components' summed prices and the saving. */
export interface KitPrice {
    /** What one kit costs the buyer: its own price, never more than `compareAtMinor`. */
    priceMinor: number;
    /** Every component at its current price times its quantity. */
    compareAtMinor: number;
    savingMinor: number;
    /** The saving as a whole percent of the compare-at (0 without one). */
    savingPercent: number;
    /** Each component's share of the saving for one kit, in component order. */
    componentSavingsMinor: number[];
}

/**
 * One kit's price from its own price and its components' prices (all in the
 * same currency, each resolved by the one precedence): `bundleGroupPricing`
 * with one fixed-price set made of exactly one kit's units.
 */
export function kitPrice(
    kitPriceMinor: number,
    components: ReadonlyArray<{ unitPriceMinor: number; quantity: number }>,
    /** The currency's price increment. */
    incrementMinor: number,
): KitPrice {
    const units = components.reduce((total, component) => total + component.quantity, 0);
    const pricing = bundleGroupPricing(
        components.map((component, index) => ({ key: String(index), unitPriceMinor: component.unitPriceMinor, quantity: component.quantity })),
        units > 0 && kitPriceMinor > 0
            ? [{ quantity: units, discountType: "fixed_price", priceMinor: kitPriceMinor, label: null, isActive: true }]
            : [],
        incrementMinor,
    );
    const compareAtMinor = pricing.plainMinor;
    const priceMinor = units > 0 ? pricing.totalMinor : kitPriceMinor;
    const savingMinor = pricing.savingMinor;
    return {
        priceMinor,
        compareAtMinor,
        savingMinor,
        savingPercent: compareAtMinor > 0 ? Math.round((savingMinor * 100) / compareAtMinor) : 0,
        componentSavingsMinor: pricing.lineSavings.map((line) => line.savingMinor),
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
export function kitComponentDeliverySql(variant: { id: SQL; productId: SQL; fulfillmentKind: SQL }): SQL<string | null> {
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
