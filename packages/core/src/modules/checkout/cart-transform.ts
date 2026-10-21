import { validateCheckoutAttributes } from "./attributes";
// Cart transform (`cart.transform`, docs/platform/PLUGINS.md): Shopify's
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
// The bundle rides on each order line as a `_bundle` property ("Bundle:
// <title>"), shown wherever line inputs are shown.
//
// Rules (pure, `applyCartTransform`):
// - Apps in priority order (lower first, then app id), each app's operations
//   in order. A line is in at most one operation: a later one naming it is
//   skipped. So is one naming a line that is not in the cart, a gift-card
//   line (money is never bundled), a component SKU that does not exist, or
//   an expansion that would take the cart over 99 lines. Each skip is logged
//   for the merchant; nothing is guessed.
// - A line with buyer inputs (engraving…) is never expanded: its
//   components could not keep them.
// - Only valid lines are transformed: a line with an issue (out of stock,
//   unavailable) reaches the buyer as it is. Set a bundle SKU to not track
//   stock; its components carry it.
// - A bundle line keeps the buyer's line identity in what the buyer sees
//   (`presentTransformedCart`): one line per buyer line, priced as the sum
//   of its components, with the buyer's submitted price checked against it.
//
// With no active app at the point there is no read and no call.

import type { Database } from "@scalius/database/client";
import { productVariants } from "@scalius/database/schema";
import type { FunctionCart, PluginFunctionOutput } from "@scalius/shared/plugins";
import type { ResolvedLineProperty } from "@scalius/shared/line-properties";
import { and, inArray, isNull } from "drizzle-orm";
import { fromMinor, toMinor } from "@scalius/shared/money";
import { buildStorefrontTaxAllocationLineId } from "../tax";
import {
    appCartMarketCountry,
    buildAppFunctionCart,
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
export const BUNDLE_LINE_PROPERTY_KEY = "_bundle";

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
            apps,
            points: ["cart.transform"],
            attributes,
        });
        let cart: FunctionCart;
        try {
            cart = buildAppFunctionCart({
                currency: { code: preliminary.money.currencyCode, decimalPlaces: preliminary.money.decimalPlaces },
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
                    purchaseOption: item.purchaseOption?.id ?? null,
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
        if (results.every((result) => result.output.operations.length === 0)) return null;
        // The product of each component SKU, in one read (live SKUs only).
        const componentIds = [...new Set(results.flatMap((result) => result.output.operations
            .flatMap((operation) => (operation.op === "expand" ? operation.components.map((component) => component.variantId) : []))))];
        // D1 binds at most 100 parameters: read in sequential chunks of 90.
        const products = new Map<string, string>();
        for (let start = 0; start < componentIds.length; start += 90) {
            const rows = await db.select({ id: productVariants.id, productId: productVariants.productId })
                .from(productVariants)
                .where(and(inArray(productVariants.id, componentIds.slice(start, start + 90)), isNull(productVariants.deletedAt)))
                .all();
            for (const row of rows) products.set(row.id, row.productId);
        }
        return applyCartTransform(items, valid, lineIds, results, products, apps);
    };
}

/** The transformed cart by the rules above (pure); null when no operation applies. */
export function applyCartTransform(
    items: readonly StorefrontCartValidationItem[],
    valid: ReadonlyArray<Pick<StorefrontCartValidatedItem, "index" | "isGiftCard" | "productName" | "variantLabel" | "properties">>,
    lineIds: readonly string[],
    results: ReadonlyArray<Pick<CheckoutAppFunctionResult<"cart.transform">, "pluginId" | "output">>,
    componentProducts: ReadonlyMap<string, string>,
    apps?: Pick<CheckoutAppFunctions, "report">,
): TransformedCart | null {
    const lineIndex = new Map(lineIds.map((lineId, position) => [lineId, valid[position]!]));
    const used = new Set<number>();
    const expanded = new Map<number, { title: string; components: Array<{ variantId: string; productId: string; perUnit: number }> }>();
    const merged = new Map<number, CartLineBundle>();
    let lineCount = items.length;
    const skip = (pluginId: string, message: string) => apps?.report(pluginId, "cart.transform", `${message} It was skipped.`);

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
            const found = lines as Array<Pick<StorefrontCartValidatedItem, "index" | "isGiftCard" | "productName" | "variantLabel" | "properties">>;
            if (new Set(found.map((line) => line.index)).size !== found.length || found.some((line) => used.has(line.index))) {
                skip(result.pluginId, `Operation ${operation.op} names a line another operation already changed.`);
                continue;
            }
            if (found.some((line) => line.isGiftCard)) {
                skip(result.pluginId, `Operation ${operation.op} names a gift card, which is never bundled.`);
                continue;
            }
            if (operation.op === "expand" && found[0]!.properties.length > 0) {
                skip(result.pluginId, `Expand names line ${operation.lineId}, which carries buyer inputs its components cannot keep.`);
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
                // The bundle is bought the buyer's way: each component keeps the line's purchase option.
                ...(item.purchaseOption ? { purchaseOption: item.purchaseOption } : {}),
            });
        }
        expansions.push({ sourceIndex, title: expansion.title, components });
    });
    return { items: transformed, expansions };
}

/** The `_bundle` order-line property of a bundle line ("Bundle: <title>"); none for a plain line. */
export function bundleLineProperties(bundle: CartLineBundle | null | undefined): ResolvedLineProperty[] {
    if (!bundle) return [];
    const title = bundle.title.slice(0, 200);
    return [{ key: BUNDLE_LINE_PROPERTY_KEY, type: "text", label: "Bundle", value: title, displayValue: title, priceMinor: 0 }];
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
            properties: [],
            canonicalProperties: [],
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
        const available = componentAvailable === undefined ? undefined : Math.floor(componentAvailable / perUnit);
        return {
            ...rest,
            index: source,
            cartKey: buyer.cartKey ?? null,
            productId: buyer.productId,
            variantId: buyer.variantId,
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
