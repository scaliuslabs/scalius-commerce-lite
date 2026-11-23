// A kit cart line's contents as the buyer reads them (`kitItems` on the cart
// check's line): each item's name and option values in the request's
// language, its units per kit and its picture, in the kit's order. Built from
// the rows the cart check already reads (its kits' items' products, SKUs and
// pictures ride in the cart's own statements, `cartProductIdsSql`), the
// option values and translations folded into the kit's components
// (`kitComponentsSql` with `items`): no statement of its own.
import type { SQL } from "drizzle-orm";
import {
    parseVariantOptionValues,
    resolveSkuImageRepresentation,
    type KitComponentRef,
    type KitItem,
    type ProductMediaProjection,
} from "../products";
import { applyTranslation, foldedProductChains, productTranslationRowsSql, type TranslationScope } from "../translations";

/** What a cart check reads of its kits' items: their facts, in the presence's language when it has one. */
export interface CartKitItemsRead {
    translation: TranslationScope | null;
}

/** The fold `kitComponentsSql` takes for a cart check's kits. */
export function cartKitItemsFold(read: CartKitItemsRead): { translations?: (productId: SQL) => SQL<string | null> } {
    const scope = read.translation;
    return scope ? { translations: (productId) => productTranslationRowsSql(scope, productId) } : {};
}

/**
 * A kit's items for its buyer line, or null when one can't be named (its
 * product or SKU is not in the cart's rows: the kit is refused anyway).
 */
export function cartKitItems(
    components: readonly KitComponentRef[],
    rows: {
        products: ReadonlyMap<string, { name: string }>;
        variants: ReadonlyMap<string, { imageId: string | null }>;
        mediaByProduct: ReadonlyMap<string, ProductMediaProjection[]>;
    },
    read: CartKitItemsRead,
): KitItem[] | null {
    const items: KitItem[] = [];
    for (const component of components) {
        const product = component.productId ? rows.products.get(component.productId) : undefined;
        const variant = rows.variants.get(component.variantId);
        if (!component.productId || !product || !variant) return null;
        const chains = read.translation && component.facts?.translations
            ? foldedProductChains(read.translation, component.facts.translations)
            : null;
        const picture = resolveSkuImageRepresentation(rows.mediaByProduct.get(component.productId) ?? [], variant.imageId);
        items.push({
            variantId: component.variantId,
            productId: component.productId,
            productName: chains
                ? applyTranslation({ name: product.name }, chains.get(`product:${component.productId}`) ?? [], { name: "name" }).name
                : product.name,
            options: parseVariantOptionValues(component.facts?.options ?? null, chains ? {
                option: (id, name) => applyTranslation({ name }, chains.get(`product_option:${id}`) ?? [], { name: "name" }).name,
                value: (id, text) => applyTranslation({ value: text }, chains.get(`product_option_value:${id}`) ?? [], { value: "value" }).value,
            } : undefined),
            quantity: component.quantity,
            imageUrl: picture?.url ?? null,
            imageMediaId: picture?.mediaId ?? null,
            imageAlt: picture?.altText ?? null,
        });
    }
    return items;
}
