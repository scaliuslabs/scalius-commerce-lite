import { validateCheckoutAttributes } from "./attributes";
// Cart transform (`cart.transform`, packages/plugin-sdk/docs/apps.md): Shopify's
// cartTransform. An app says what the buyer's lines are, never what they
// cost:
//
// - `expand`: a line (a bundle SKU) is sold as component SKUs, each
//   `quantity` per bundle unit. The components are the order's lines, so
//   stock, tax, fulfilment, refunds and returns follow them with no new
//   path; the bundle SKU itself is never reserved. Each component is priced
//   like any SKU (an app prices bundles with `cart.line_prices` or a
//   discount).
// - `merge`: lines are one bundle on the order; nothing else changes.
//
// The bundle rides on each order line as a `_bundle` entry ("Bundle:
// <title>"), shown wherever line inputs are shown, with its membership
// (`orderLineBundles`): the bundle's id, whether the line is its anchor,
// the units bought and the line's units in each, so an app reading the order
// (`bundle` on each line) counts bundle units, never the anchor's quantity.
//
// Rules (pure, `applyCartTransform`):
// - Apps in priority order (lower first, then app id), each app's operations
//   in order. A line is in at most one operation: a later one naming it is
//   skipped. So is one naming a line that is not in the cart, a gift-card
//   line (money is never bundled), a component SKU that does not exist, or
//   an expansion that would take the cart over 99 lines. Each skip is logged
//   for the merchant; nothing is guessed.
// - A line with buyer inputs keeps them on the bundle as a whole
//   (`CartLineBundle.properties`): functions see them on each component, an
//   app's add-on for them is one fee per bundle unit, and the order freezes
//   them once, on the bundle's anchor. A line whose own inputs carry a
//   surcharge is never expanded: no component could charge it.
// - Only valid lines are transformed: a line with an issue (out of stock,
//   unavailable) reaches the buyer as it is. Set a bundle SKU to not track
//   stock; its components carry it.
// - A bundle line keeps the buyer's line identity in what the buyer sees
//   (`presentTransformedCart`): one line per buyer line, priced as the sum
//   of its components, with the buyer's submitted price checked against it.
//
// Kits (products/kits.ts) are the store's own expansion through the same
// rules: a kit line is expanded first, before any app runs, with the kit's
// price on its bundle (`CartLineBundle.kit`), so an app's operation naming a
// kit line is skipped (logged), and so is an app expanding a line into a kit:
// a kit is sold only as its components. Cart validation expands kits itself
// when no app implements the point (`expandCartKits`), in the reads it
// already ran.
//
// With no active app at the point there is no read and no call.

import type { Database } from "@scalius/database/client";
import { productVariants } from "@scalius/database/schema";
import type { FunctionCart, PluginFunctionOutput } from "@scalius/shared/plugins";
import { LINE_BUNDLE_PROPERTY_KEY, lineBundleProperty, type OrderLineBundle, type ResolvedLineProperty } from "@scalius/shared/line-properties";
import { and, inArray, isNull, sql } from "drizzle-orm";
import { fromMinor, toMinor } from "@scalius/shared/money";
import { buildStorefrontTaxAllocationLineId } from "../tax";
import { bundleAnchors } from "./app-line-prices";
import {
    appCartMarketCountry,
    buildAppFunctionCart,
    functionStoreCurrency,
    loadAppFunctionCartFacts,
    type CheckoutAppFunctionResult,
    type CheckoutAppFunctions,
} from "./app-functions";
import type {
    CartLineBundle,
    StorefrontCartItemIssue,
    StorefrontCartValidatedItem,
    StorefrontCartValidationItem,
    StorefrontCartValidationResult,
} from "./cart-validation";

/** The most lines a transformed cart may have (an order's line limit). */
export const CART_TRANSFORM_MAX_LINES = 99;

/** The order-line property a bundle line carries. */
export const BUNDLE_LINE_PROPERTY_KEY = LINE_BUNDLE_PROPERTY_KEY;

/** The buyer's lines as the apps rewrote them. */
export interface TransformedCart {
    /** What checkout validates, prices and orders. */
    items: StorefrontCartValidationItem[];
    /** Per buyer line that was expanded: its components' quantity per bundle unit, by component position in `items`. */
    expansions: Array<{ sourceIndex: number; title: string; components: Array<{ position: number; perUnit: number }> }>;
}

/**
 * Rewrites a cart with the apps (`cart.transform`) from its first, priced
 * pass. Null when nothing changed. Built per request by
 * `createCartTransformer`; absent when no app implements the point.
 */
export type CartTransformer = (
    items: readonly StorefrontCartValidationItem[],
    preliminary: StorefrontCartValidationResult,
) => Promise<TransformedCart | null>;

export interface CartTransformContext {
    channel: FunctionCart["channel"];
    customerId?: string | null | PromiseLike<string | null>;
    destination?: { country?: string | null; city: string | null; zone: string | null } | null;
    discountCodes?: readonly string[];
    attributes?: Record<string, string>;
}

/** The transformer for this request, or undefined when no active app implements `cart.transform`. */
export function createCartTransformer(
    db: Database,
    apps: CheckoutAppFunctions | undefined,
    context: CartTransformContext,
): CartTransformer | undefined {
    if (!apps?.points.has("cart.transform")) return undefined;
    const attributes = validateCheckoutAttributes(apps, context.attributes);
    return async (items, preliminary) => {
        const valid = preliminary.items;
        if (valid.length === 0) return null;
        const customerId = (await context.customerId) ?? null;
        const lineIds = valid.map((item) => buildStorefrontTaxAllocationLineId(item.index, item.variantId));
        const facts = await loadAppFunctionCartFacts(db, {
            productIds: valid.map((item) => item.productId),
            variantIds: valid.map((item) => item.variantId),
            customerId,
            marketCountry: appCartMarketCountry(context.destination ?? null),
            market: preliminary.marketContext,
            apps,
            points: ["cart.transform"],
            attributes,
        });
        let cart: FunctionCart;
        try {
            cart = buildAppFunctionCart({
                currency: { code: preliminary.money.currencyCode, decimalPlaces: preliminary.money.decimalPlaces },
                storeCurrency: functionStoreCurrency(preliminary.money),
                channel: context.channel,
                segmentIds: preliminary.pricingSegmentIds,
                lines: valid.map((item, position) => ({
                    lineId: lineIds[position]!,
                    productId: item.productId,
                    variantId: item.variantId,
                    title: item.variantLabel ? `${item.productName} (${item.variantLabel})` : item.productName,
                    quantity: item.quantity,
                    unitPriceMinor: item.unitPriceMinor,
                    discountMinor: 0,
                    properties: item.properties,
                    purchaseOptions: (item.purchaseOptions ?? []).map((option) => option.id),
                })),
                facts,
                destination: context.destination ?? null,
                discountCodes: context.discountCodes ?? [],
                attributes,
            });
        } catch (error) {
            console.error(`[checkout] app transform cart could not be built: ${error instanceof Error ? error.name : "error"}`);
            return null;
        }
        const results = await apps.run("cart.transform", { cart });
        const kits = cartKitExpansions(valid);
        if (kits.size === 0 && results.every((result) => result.output.operations.length === 0)) return null;
        // The product of each component SKU, in one read (live SKUs only); a kit is never a component.
        const componentIds = [...new Set(results.flatMap((result) => result.output.operations
            .flatMap((operation) => (operation.op === "expand" ? operation.components.map((component) => component.variantId) : []))))];
        // D1 binds at most 100 parameters: read in sequential chunks of 90.
        const products = new Map<string, string>();
        const kitSkus = new Set<string>();
        for (let start = 0; start < componentIds.length; start += 90) {
            const rows = await db.select({
                id: productVariants.id,
                productId: productVariants.productId,
                isKit: sql<number>`EXISTS (SELECT 1 FROM variant_components AS app_kit WHERE app_kit.kit_variant_id = ${productVariants.id})`,
            })
                .from(productVariants)
                .where(and(inArray(productVariants.id, componentIds.slice(start, start + 90)), isNull(productVariants.deletedAt)))
                .all();
            for (const row of rows) {
                if (Number(row.isKit) === 1) kitSkus.add(row.id);
                else products.set(row.id, row.productId);
            }
        }
        return applyCartTransform(items, valid, lineIds, results, products, apps, kits, kitSkus);
    };
}

/** A kit line as the store expands it: its title, components and price per kit. */
export interface CartKitExpansion {
    title: string;
    variantId: string;
    productId: string;
    unitPriceMinor: number;
    components: Array<{ variantId: string; productId: string; quantity: number }>;
}

/** The valid kit lines of a first pass (`kitComponents`), by line index. */
export function cartKitExpansions(
    valid: ReadonlyArray<Pick<StorefrontCartValidatedItem, "index" | "productId" | "variantId" | "productName" | "variantLabel" | "baseUnitPriceMinor" | "kitComponents" | "bundle">>,
): Map<number, CartKitExpansion> {
    const kits = new Map<number, CartKitExpansion>();
    for (const line of valid) {
        if (!line.kitComponents || line.bundle) continue;
        kits.set(line.index, {
            title: line.variantLabel ? `${line.productName} (${line.variantLabel})` : line.productName,
            variantId: line.variantId,
            productId: line.productId,
            unitPriceMinor: line.baseUnitPriceMinor,
            components: line.kitComponents,
        });
    }
    return kits;
}

/**
 * The store's own kits expanded with no app at the point: the first pass's
 * kit lines, by `applyCartTransform`'s rules. Null when the cart has none.
 */
export function expandCartKits(
    items: readonly StorefrontCartValidationItem[],
    preliminary: Pick<StorefrontCartValidationResult, "items">,
): TransformedCart | null {
    const valid = preliminary.items;
    const kits = cartKitExpansions(valid);
    if (kits.size === 0) return null;
    const lineIds = valid.map((item) => buildStorefrontTaxAllocationLineId(item.index, item.variantId));
    return applyCartTransform(items, valid, lineIds, [], new Map(), undefined, kits);
}

/** The transformed cart by the rules above (pure); null when no operation applies. */
export function applyCartTransform(
    items: readonly StorefrontCartValidationItem[],
    valid: ReadonlyArray<Pick<StorefrontCartValidatedItem, "index" | "isGiftCard" | "productName" | "variantLabel" | "properties"> & Partial<Pick<StorefrontCartValidatedItem, "canonicalProperties" | "propertiesPriceMinor" | "lineInputs">>>,
    lineIds: readonly string[],
    results: ReadonlyArray<Pick<CheckoutAppFunctionResult<"cart.transform">, "pluginId" | "output">>,
    componentProducts: ReadonlyMap<string, string>,
    apps?: Pick<CheckoutAppFunctions, "report">,
    /** The store's kits (`cartKitExpansions`), expanded before any app's operation. */
    kits: ReadonlyMap<number, CartKitExpansion> = new Map(),
    /** Component SKUs an app named that are kits: a kit is never a component. */
    kitSkus: ReadonlySet<string> = new Set(),
): TransformedCart | null {
    const lineIndex = new Map(lineIds.map((lineId, position) => [lineId, valid[position]!]));
    const used = new Set<number>();
    const expanded = new Map<number, { title: string; components: Array<{ variantId: string; productId: string; perUnit: number }>; inputs: Pick<CartLineBundle, "properties" | "canonicalProperties" | "lineInputs">; kit?: CartLineBundle["kit"] }>();
    const merged = new Map<number, CartLineBundle>();
    let lineCount = items.length;
    const skip = (pluginId: string, message: string) => apps?.report(pluginId, "cart.transform", `${message} It was skipped.`);
    const bundleInputs = (parent: (typeof valid)[number]) => ({
        ...(parent.properties.length > 0 ? { properties: parent.properties, canonicalProperties: parent.canonicalProperties ?? [] } : {}),
        ...(parent.lineInputs?.length ? { lineInputs: parent.lineInputs } : {}),
    });

    // The store's kits first: a kit line is never an app's to change.
    for (const parent of valid) {
        const kit = kits.get(parent.index);
        if (!kit) continue;
        // A priced buyer input has no component to charge it; a cart past the line limit stays as it is:
        // either way the kit line is refused by the final pass, never sold as itself.
        if ((parent.propertiesPriceMinor ?? 0) > 0 || lineCount - 1 + kit.components.length > CART_TRANSFORM_MAX_LINES) {
            used.add(parent.index);
            continue;
        }
        lineCount += kit.components.length - 1;
        used.add(parent.index);
        expanded.set(parent.index, {
            title: kit.title,
            components: kit.components.map((component) => ({ variantId: component.variantId, productId: component.productId, perUnit: component.quantity })),
            inputs: bundleInputs(parent),
            kit: { variantId: kit.variantId, productId: kit.productId, unitPriceMinor: kit.unitPriceMinor, components: kit.components.length },
        });
    }

    for (const result of results) {
        const operations = (result.output as PluginFunctionOutput<"cart.transform">).operations;
        for (const operation of operations) {
            const ids = operation.op === "expand" ? [operation.lineId] : operation.lineIds;
            const lines = ids.map((id) => lineIndex.get(id));
            const missing = ids.find((_, position) => !lines[position]);
            if (missing) {
                skip(result.pluginId, `Operation ${operation.op} names line ${missing}, which is not in the cart.`);
                continue;
            }
            const found = lines as Array<(typeof valid)[number]>;
            if (found.some((line) => kits.has(line.index))) {
                skip(result.pluginId, `Operation ${operation.op} names a kit, which the store sells as its components.`);
                continue;
            }
            if (new Set(found.map((line) => line.index)).size !== found.length || found.some((line) => used.has(line.index))) {
                skip(result.pluginId, `Operation ${operation.op} names a line another operation already changed.`);
                continue;
            }
            if (found.some((line) => line.isGiftCard)) {
                skip(result.pluginId, `Operation ${operation.op} names a gift card, which is never bundled.`);
                continue;
            }
            if (operation.op === "expand" && (found[0]!.propertiesPriceMinor ?? 0) > 0) {
                skip(result.pluginId, `Expand names line ${operation.lineId}, whose buyer inputs carry a surcharge no component can charge.`);
                continue;
            }
            if (operation.op === "merge") {
                const bundle: CartLineBundle = { id: lineIds[valid.indexOf(found[0]!)]!, title: operation.title, kind: "merge" };
                for (const line of found) {
                    used.add(line.index);
                    merged.set(line.index, bundle);
                }
                continue;
            }
            const quantities = new Map<string, number>();
            for (const component of operation.components) quantities.set(component.variantId, (quantities.get(component.variantId) ?? 0) + component.quantity);
            const kitComponent = [...quantities.keys()].find((variantId) => kitSkus.has(variantId));
            if (kitComponent) {
                skip(result.pluginId, `Expand names SKU ${kitComponent}, which is a kit: a kit is never a component.`);
                continue;
            }
            const unknown = [...quantities.keys()].find((variantId) => !componentProducts.has(variantId));
            if (unknown) {
                skip(result.pluginId, `Expand names SKU ${unknown}, which does not exist.`);
                continue;
            }
            if (lineCount - 1 + quantities.size > CART_TRANSFORM_MAX_LINES) {
                skip(result.pluginId, `Expanding line ${operation.lineId} would take the cart over ${CART_TRANSFORM_MAX_LINES} lines.`);
                continue;
            }
            lineCount += quantities.size - 1;
            const parent = found[0]!;
            used.add(parent.index);
            expanded.set(parent.index, {
                title: operation.title ?? (parent.variantLabel ? `${parent.productName} (${parent.variantLabel})` : parent.productName),
                components: [...quantities].map(([variantId, perUnit]) => ({ variantId, productId: componentProducts.get(variantId)!, perUnit })),
                // The buyer's inputs stay the bundle's as a whole, never copied onto a component's own.
                inputs: bundleInputs(parent),
            });
        }
    }
    if (used.size === 0) return null;

    const transformed: StorefrontCartValidationItem[] = [];
    const expansions: TransformedCart["expansions"] = [];
    items.forEach((item, sourceIndex) => {
        const expansion = expanded.get(sourceIndex);
        if (!expansion) {
            const bundle = merged.get(sourceIndex);
            transformed.push({ ...item, sourceIndex, ...(bundle ? { bundle } : {}) });
            return;
        }
        const bundle: CartLineBundle = {
            id: lineIds[valid.findIndex((line) => line.index === sourceIndex)]!,
            title: expansion.title,
            kind: "expand",
            units: item.quantity,
            ...expansion.inputs,
            ...(expansion.kit ? { kit: expansion.kit } : {}),
        };
        const components: TransformedCart["expansions"][number]["components"] = [];
        for (const component of expansion.components) {
            components.push({ position: transformed.length, perUnit: component.perUnit });
            transformed.push({
                cartKey: item.cartKey ?? null,
                productId: component.productId,
                variantId: component.variantId,
                quantity: component.perUnit * item.quantity,
                bundle,
                sourceIndex,
                // The bundle is bought the buyer's way: each component keeps the line's purchase options.
                ...(item.purchaseOptions !== undefined && item.purchaseOptions !== null ? { purchaseOptions: item.purchaseOptions } : {}),
            });
        }
        expansions.push({ sourceIndex, title: expansion.title, components });
    });
    return { items: transformed, expansions };
}

/**
 * Each bundle line's membership as the order freezes it, by line index (a
 * plain line has none): its bundle, whether it is the bundle's anchor (an
 * expanded bundle's component holding the fewest per bundle unit, the first
 * such, as `bundleAnchors` places the bundle's inputs and add-ons; a merged
 * bundle's first line), and for an expanded bundle its units bought and the
 * line's units in each.
 */
export function orderLineBundles(items: ReadonlyArray<Pick<StorefrontCartValidatedItem, "index" | "quantity" | "bundle">>): Map<number, OrderLineBundle> {
    const anchors = bundleAnchors(items);
    const firstMerged = new Map<string, number>();
    const bundles = new Map<number, OrderLineBundle>();
    for (const item of items) {
        const bundle = item.bundle;
        if (!bundle) continue;
        if (bundle.kind === "merge") {
            if (!firstMerged.has(bundle.id)) firstMerged.set(bundle.id, item.index);
            bundles.set(item.index, { id: bundle.id, title: bundle.title, kind: "merge", kit: null, anchor: firstMerged.get(bundle.id) === item.index, units: null, perUnit: null });
            continue;
        }
        // Each component holds `perUnit × units` (applyCartTransform), so the division is exact.
        const units = bundle.units ?? null;
        const perUnit = units ? item.quantity / units : null;
        const whole = units !== null && perUnit !== null && Number.isSafeInteger(perUnit) && perUnit > 0;
        bundles.set(item.index, {
            // A store kit names itself: its kind and its own SKU and product.
            id: bundle.id, title: bundle.title, kind: bundle.kit ? "kit" : "expand",
            kit: bundle.kit ? { variantId: bundle.kit.variantId, productId: bundle.kit.productId } : null,
            anchor: anchors.get(bundle.id)?.index === item.index,
            units: whole ? units : null, perUnit: whole ? perUnit : null,
        });
    }
    return bundles;
}

/** A line's `_bundle` entry ("Bundle: <title>" and its membership); none for a plain line. */
export function bundleLineProperties(bundle: OrderLineBundle | undefined): ResolvedLineProperty[] {
    return bundle ? [lineBundleProperty(bundle)] : [];
}

/**
 * The buyer's view of a transformed cart: one line per buyer line (an
 * expanded line priced as the sum of its components per bundle unit) and
 * issues on the buyer's lines. An expanded line whose submitted price is not
 * that sum gets a price_changed issue, so the cart refreshes it as for any
 * line. `valid` follows.
 */
export function presentTransformedCart(
    result: StorefrontCartValidationResult,
    transform: TransformedCart,
    buyerItems: readonly StorefrontCartValidationItem[],
): StorefrontCartValidationResult {
    return presentTransformedCartLines(result, transform, buyerItems).cart;
}

/**
 * `presentTransformedCart` and, per presented line, the position of its
 * (first) rewritten line, to pick per-line facts computed for the rewritten
 * cart (fulfilment types, input hashes).
 */
export function presentTransformedCartLines(
    result: StorefrontCartValidationResult,
    transform: TransformedCart,
    buyerItems: readonly StorefrontCartValidationItem[],
): { cart: StorefrontCartValidationResult; positions: number[] } {
    const decimalPlaces = result.money.decimalPlaces;
    const issues = issuesOnBuyerLines(result.issues, transform, buyerItems);
    const byPosition = new Map(result.items.map((item) => [item.index, item]));
    const expandedSources = new Map(transform.expansions.map((expansion) => [expansion.sourceIndex, expansion]));
    const items: StorefrontCartValidatedItem[] = [];
    const positions = new Map<number, number>();
    const seen = new Set<number>();
    for (const item of result.items) {
        const source = item.sourceIndex;
        const expansion = expandedSources.get(source);
        if (!expansion) {
            items.push({ ...item, index: source });
            positions.set(source, item.index);
            continue;
        }
        if (seen.has(source)) continue;
        seen.add(source);
        const components = expansion.components.map((component) => ({ ...component, item: byPosition.get(component.position) }));
        // A component with an issue: the issue speaks for the bundle line.
        if (components.some((component) => !component.item)) continue;
        const buyer = buyerItems[source]!;
        const bundleUnitMinor = components.reduce((sum, component) => sum + component.item!.unitPriceMinor * component.perUnit, 0);
        const available = components.reduce<number | null>((least, component) => {
            const quantity = component.item!.availableQuantity;
            if (quantity === null) return least;
            const units = Math.floor(quantity / component.perUnit);
            return least === null ? units : Math.min(least, units);
        }, null);
        const first = components[0]!.item!;
        const submitted = typeof buyer.price === "number" && Number.isFinite(buyer.price) ? toMinor(buyer.price, decimalPlaces) : undefined;
        if (submitted !== undefined && submitted !== bundleUnitMinor) {
            issues.push({
                index: source,
                cartKey: buyer.cartKey ?? null,
                productId: buyer.productId,
                variantId: buyer.variantId,
                code: "price_changed",
                action: "refresh_item",
                message: `The price for ${expansion.title} changed. Please review the updated cart total.`,
                productName: expansion.title,
                variantLabel: null,
                requestedQuantity: buyer.quantity,
                submittedPrice: buyer.price,
                currentPrice: fromMinor(bundleUnitMinor, decimalPlaces),
            });
            continue;
        }
        positions.set(source, first.index);
        items.push({
            ...first,
            index: source,
            sourceIndex: source,
            cartKey: buyer.cartKey ?? null,
            productId: buyer.productId,
            variantId: buyer.variantId,
            quantity: buyer.quantity,
            unitPriceMinor: bundleUnitMinor,
            baseUnitPriceMinor: bundleUnitMinor,
            propertiesPriceMinor: 0,
            // The bundle's inputs, as the buyer's line carried them (its key hashes them).
            properties: first.bundle?.properties ?? [],
            canonicalProperties: first.bundle?.canonicalProperties ?? [],
            lineInputs: first.bundle?.lineInputs ?? [],
            productName: expansion.title,
            variantLabel: null,
            availableQuantity: available,
            freeDelivery: components.every((component) => component.item!.freeDelivery),
        });
    }
    issues.sort((left, right) => left.index - right.index);
    items.sort((left, right) => left.index - right.index);
    const subtotalMinor = items.reduce((sum, item) => sum + item.unitPriceMinor * item.quantity, 0);
    return {
        cart: { ...result, valid: issues.length === 0, issues, items, subtotalMinor },
        positions: items.map((item) => positions.get(item.index)!),
    };
}

/**
 * Issues of the rewritten lines on the buyer's lines. An issue on an
 * expanded line's component speaks for the bundle line: its quantities are
 * in bundle units (a component that has 5 left at 2 per bundle leaves 2
 * bundles), so "reduce the quantity" asks the buyer for a bundle quantity
 * that the components can fill.
 */
export function issuesOnBuyerLines(
    issues: readonly StorefrontCartItemIssue[],
    transform: TransformedCart,
    buyerItems: readonly StorefrontCartValidationItem[],
): StorefrontCartItemIssue[] {
    const perUnitAt = new Map<number, number>();
    for (const expansion of transform.expansions) {
        for (const component of expansion.components) perUnitAt.set(component.position, component.perUnit);
    }
    return issues.map((issue) => {
        const source = transform.items[issue.index]?.sourceIndex ?? issue.index;
        const perUnit = perUnitAt.get(issue.index);
        const buyer = buyerItems[source];
        if (perUnit === undefined || !buyer) return { ...issue, index: source };
        const { availableQuantity: componentAvailable, ...rest } = issue;
        // The same SKU on the cart's other lines draws on the same units first.
        const elsewhere = transform.items.reduce((sum, line, position) =>
            position !== issue.index && line.variantId === issue.variantId ? sum + line.quantity : sum, 0);
        const available = componentAvailable === undefined ? undefined : Math.floor(Math.max(0, componentAvailable - elsewhere) / perUnit);
        return {
            ...rest,
            index: source,
            cartKey: buyer.cartKey ?? null,
            productId: buyer.productId,
            variantId: buyer.variantId,
            // The part that stops the bundle, for a client or an agent to name it.
            componentVariantId: issue.variantId,
            requestedQuantity: buyer.quantity,
            ...(available === undefined ? {} : { availableQuantity: available }),
            action: issue.action === "reduce_quantity" && available !== undefined && available < 1 ? "remove" : issue.action,
        };
    });
}

/**
 * App rule errors (`cart.validate`) on the buyer's lines: an error on a
 * rewritten line names the buyer line it came from. Unchanged without a
 * transform.
 */
export function ruleErrorsOnBuyerLines<T extends { index: number | null }>(
    errors: readonly T[],
    cart: Pick<StorefrontCartValidationResult, "items">,
): T[] {
    const sources = new Map(cart.items.map((item) => [item.index, item.sourceIndex]));
    return errors.map((error) => (error.index === null ? error : { ...error, index: sources.get(error.index) ?? error.index }));
}
