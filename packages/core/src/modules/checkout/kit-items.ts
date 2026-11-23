// A buyer's cart check reads its lines in the page's language (`CartBuyerRead`):
// every line's product name and option label, and a kit line's contents
// (`kitItems` on the cart check's line: each item's name and option values,
// its units per kit and its picture, in the kit's order). Built from the rows
// the cart check already reads: its products (and its kits' items' products)
// carry their translations as a column when a presence asks, its SKUs their
// option values, and a kit's components their option values
// (`kitComponentsSql` with `items`). No statement of its own; a check at the
// store's own language reads what it read before, a kit's options aside.
import { sql, type SQL } from "drizzle-orm";
import {
    parseVariantOptionValues,
    resolveSkuImageRepresentation,
    variantOptionValuesSql,
    type KitComponentRef,
    type KitItem,
    type ProductMediaProjection,
} from "../products";
import { applyTranslation, foldedProductChains, productTranslationRowsSql, type TranslationScope } from "../translations";
import type { TranslationRow } from "@scalius/shared/translations";

/** A buyer's cart check: its lines read in the presence's language, a kit line answers its items. */
export interface CartBuyerRead {
    translation: TranslationScope | null;
}

/** The product rows' column of their translations (product, SKUs, options, values), only when a presence asks. */
export function cartProductTranslationsSql(read: CartBuyerRead | undefined, productId: SQL): { translations?: SQL<string | null> } {
    return read?.translation ? { translations: productTranslationRowsSql(read.translation, productId) } : {};
}

/** The cart SKUs' option values (to word their label in the presence's language), only when a presence asks. */
export function cartVariantOptionValuesSql(read: CartBuyerRead | undefined, variantId: SQL, cartVariantIds: readonly string[]): { optionValues?: SQL<string | null> } {
    if (!read?.translation) return {};
    // Only the cart's own SKUs pay for it: the CASE never runs the subquery for a sibling SKU.
    return { optionValues: sql<string | null>`CASE WHEN ${variantId} IN (SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify([...new Set(cartVariantIds)])})) THEN ${variantOptionValuesSql(variantId)} END` };
}

type Chains = Map<string, TranslationRow[]>;

function optionWords(chains: Chains | null) {
    return chains ? {
        option: (id: string, name: string) => applyTranslation({ name }, chains.get(`product_option:${id}`) ?? [], { name: "name" }).name,
        value: (id: string, text: string) => applyTranslation({ value: text }, chains.get(`product_option_value:${id}`) ?? [], { value: "value" }).value,
    } : undefined;
}

/**
 * The cart's rows in the presence's language: each product's name, and each
 * cart SKU's option label (its values in option order, " / " between, as
 * `variantOptionLabelSql` writes it). Every line, issue and kit item of the
 * check then reads one language. Rows without translations are returned as read.
 */
export function translateCartRows<
    P extends { id: string; name: string; translations?: string | null },
    V extends { productId: string; optionLabel: string | null; optionValues?: string | null },
>(read: CartBuyerRead | undefined, productRows: readonly P[], variantRows: readonly V[]): { productRows: P[]; variantRows: V[]; chains: Map<string, Chains> } {
    const chains = new Map<string, Chains>();
    if (!read?.translation) return { productRows: [...productRows], variantRows: [...variantRows], chains };
    for (const row of productRows) {
        if (row.translations) chains.set(row.id, foldedProductChains(read.translation, row.translations));
    }
    return {
        chains,
        productRows: productRows.map((row) => {
            const own = chains.get(row.id);
            return own ? { ...row, name: applyTranslation({ name: row.name }, own.get(`product:${row.id}`) ?? [], { name: "name" }).name } : row;
        }),
        variantRows: variantRows.map((row) => {
            const own = chains.get(row.productId);
            if (!own || !row.optionValues) return row;
            const values = parseVariantOptionValues(row.optionValues, optionWords(own)).map((option) => option.value);
            return values.length > 0 ? { ...row, optionLabel: values.join(" / ") } : row;
        }),
    };
}

/**
 * A kit's items for its buyer line, or null when one can't be named (its
 * product or SKU is not in the cart's rows: the kit is refused anyway). The
 * rows are the check's, already in the presence's language (`translateCartRows`).
 */
export function cartKitItems(
    components: readonly KitComponentRef[],
    rows: {
        products: ReadonlyMap<string, { name: string }>;
        variants: ReadonlyMap<string, { imageId: string | null }>;
        mediaByProduct: ReadonlyMap<string, ProductMediaProjection[]>;
        chains: ReadonlyMap<string, Chains>;
    },
): KitItem[] | null {
    const items: KitItem[] = [];
    for (const component of components) {
        const product = component.productId ? rows.products.get(component.productId) : undefined;
        const variant = rows.variants.get(component.variantId);
        if (!component.productId || !product || !variant) return null;
        const picture = resolveSkuImageRepresentation(rows.mediaByProduct.get(component.productId) ?? [], variant.imageId);
        items.push({
            variantId: component.variantId,
            productId: component.productId,
            productName: product.name,
            options: parseVariantOptionValues(component.facts?.options ?? null, optionWords(rows.chains.get(component.productId) as Chains | undefined ?? null)),
            quantity: component.quantity,
            imageUrl: picture?.url ?? null,
            imageMediaId: picture?.mediaId ?? null,
            imageAlt: picture?.altText ?? null,
        });
    }
    return items;
}
