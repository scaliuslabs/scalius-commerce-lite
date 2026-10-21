import { validateCheckoutAttributes } from "./attributes";
// App line prices (`cart.line_prices`, docs/platform/PLUGINS.md): a checkout
// function's unit price for a cart line takes the app place in
// `resolvePrice()` (purchase option > sale > segment > market list > app >
// FX > base), so B2B contract and tiered prices replace the catalogue price
// while market and price-list rules stay authoritative, and a purchase
// option (a subscription, a rental) is priced by the app that offers it.
//
// Cart validation prices twice when an app implements the point: a first
// pass without the submitted-price check gives the app each line's price and
// its source, the app answers, and the second pass prices with the answers
// and checks the price the buyer saw against the final price. With no active
// app at the point there is one pass, as before (no read, no call).
//
// Rules (pure, `resolveAppLinePrices`):
// - Apps in priority order (lower first, then app id); the first app that
//   prices a line wins it.
// - A line bought with a purchase option is priced only by the app that
//   declares the option, and that price outranks every list; another app's
//   answer for it is skipped and logged. Without the owner's answer the
//   line keeps its one-time price.
// - A one-time line priced by a sale, segment or market list keeps that
//   price: the answer is skipped and logged for the merchant. So is a
//   gift-card line (money) and a line that is not in the cart.
// - The price rounds half-up to the market's price increment and is never
//   zero; buyer-input surcharges are added on top.
//
// Add-ons (`adjustments`, pure, `resolveAppLineAdjustments`): added to each
// unit after the whole precedence, whatever priced the line (sale, segment
// and list lines take them too). Every app's add-ons apply, in priority
// order, at most LINE_ADJUSTMENTS_PER_LINE_MAX per line; each rounds half-up
// to the cart's price increment (an add-on that rounds to nothing is
// skipped). A gift card (money), a bundle line and a line not in the cart
// take none: skipped and logged. They ride the line as `adjustments` (the
// buyer sees "Add-on: <title>") and are frozen on the order line with its
// buyer inputs, so receipts, emails, tax, totals and refunds include them.

import type { Database } from "@scalius/database/client";
import { LINE_ADJUSTMENTS_PER_LINE_MAX, type FunctionCart, type PluginFunctionOutput } from "@scalius/shared/plugins";
import type { AppLinePrice, ResolvedPriceSource } from "@scalius/shared/market-pricing";
import { lineAdjustmentProperty, type ResolvedLineProperty } from "@scalius/shared/line-properties";
import { roundToIncrementMinor } from "@scalius/shared/money";
import { purchaseOptionAppId } from "@scalius/shared/plugins/ids";
import { buildStorefrontTaxAllocationLineId } from "../tax";
import {
    appCartMarketCountry,
    buildAppFunctionCart,
    loadAppFunctionCartFacts,
    type CheckoutAppFunctionResult,
    type CheckoutAppFunctions,
} from "./app-functions";
import type {
    StorefrontCartValidatedItem,
    StorefrontCartValidationResult,
} from "./cart-validation";

/** The apps' answers for a cart, by line index: unit prices and add-ons. */
export interface AppLinePricing {
    prices: ReadonlyMap<number, AppLinePrice>;
    adjustments: ReadonlyMap<number, ResolvedLineProperty[]>;
}

const NO_APP_LINE_PRICING: AppLinePricing = { prices: new Map(), adjustments: new Map() };

/**
 * Prices a first-pass cart with the apps: the answers by line index. Built
 * per request by `createAppLinePricer`; absent when no app implements the
 * point.
 */
export type AppLinePricer = (preliminary: StorefrontCartValidationResult) => Promise<AppLinePricing>;

/** Sources whose price an app may replace: lists stay authoritative. */
const APP_PRICEABLE_SOURCES: ReadonlySet<ResolvedPriceSource> = new Set(["fx", "base"]);

export interface AppLinePricerContext {
    channel: FunctionCart["channel"];
    /** The signed-in buyer (contract prices, its declared reads); a promise is awaited only when an app runs. */
    customerId?: string | null | PromiseLike<string | null>;
    /** The region the order ships to, when known. */
    destination?: { country?: string | null; city: string | null; zone: string | null } | null;
    discountCodes?: readonly string[];
    attributes?: Record<string, string>;
}

/** The pricer for this request, or undefined when no active app implements `cart.line_prices`. */
export function createAppLinePricer(
    db: Database,
    apps: CheckoutAppFunctions | undefined,
    context: AppLinePricerContext,
): AppLinePricer | undefined {
    if (!apps?.points.has("cart.line_prices")) return undefined;
    const attributes = validateCheckoutAttributes(apps, context.attributes);
    return async (preliminary) => {
        const items = preliminary.items;
        if (items.length === 0) return NO_APP_LINE_PRICING;
        const customerId = (await context.customerId) ?? null;
        const lineIds = items.map((item) => buildStorefrontTaxAllocationLineId(item.index, item.variantId));
        const facts = await loadAppFunctionCartFacts(db, {
            productIds: items.map((item) => item.productId),
            variantIds: items.map((item) => item.variantId),
            customerId,
            marketCountry: appCartMarketCountry(context.destination ?? null),
            apps,
            points: ["cart.line_prices"],
            attributes,
        });
        let cart: FunctionCart;
        try {
            cart = buildAppFunctionCart({
                currency: { code: preliminary.money.currencyCode, decimalPlaces: preliminary.money.decimalPlaces },
                channel: context.channel,
                segmentIds: preliminary.pricingSegmentIds,
                lines: items.map((item, position) => ({
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
            // A cart that fails its own schema is a platform fault: no app runs (fail-open).
            console.error(`[checkout] app line-price cart could not be built: ${error instanceof Error ? error.name : "error"}`);
            return NO_APP_LINE_PRICING;
        }
        const results = await apps.run("cart.line_prices", {
            cart,
            lines: items.map((item, position) => ({
                lineId: lineIds[position]!,
                // The first pass never has an app price.
                source: item.priceSource === "app" ? "base" : item.priceSource,
                bundle: item.bundle ? { id: item.bundle.id, title: item.bundle.title.slice(0, 300) } : null,
            })),
        });
        return {
            prices: resolveAppLinePrices(items, lineIds, results, apps),
            adjustments: resolveAppLineAdjustments(items, lineIds, results, preliminary.money.incrementMinor, apps),
        };
    };
}

/** The winning app price of each line, by line index (see the rules above). */
export function resolveAppLinePrices(
    items: ReadonlyArray<Pick<StorefrontCartValidatedItem, "index" | "isGiftCard" | "priceSource" | "purchaseOption">>,
    lineIds: readonly string[],
    results: ReadonlyArray<Pick<CheckoutAppFunctionResult<"cart.line_prices">, "pluginId" | "output">>,
    apps?: Pick<CheckoutAppFunctions, "report">,
): Map<number, AppLinePrice> {
    const byLineId = new Map(lineIds.map((lineId, position) => [lineId, items[position]!]));
    const prices = new Map<number, AppLinePrice>();
    for (const result of results) {
        for (const answer of (result.output as PluginFunctionOutput<"cart.line_prices">).prices) {
            const item = byLineId.get(answer.lineId);
            if (!item) {
                apps?.report(result.pluginId, "cart.line_prices", `A price names line ${answer.lineId}, which is not in the cart; it was skipped.`);
                continue;
            }
            if (prices.has(item.index)) continue;
            if (item.isGiftCard) continue;
            const option = item.purchaseOption?.id ?? null;
            if (option) {
                // The option is its app's offer: only that app prices it, above every list.
                if (purchaseOptionAppId(option) !== result.pluginId) {
                    apps?.report(result.pluginId, "cart.line_prices", `Line ${answer.lineId} is bought with ${option}, which only its own app prices; it was skipped.`);
                    continue;
                }
                prices.set(item.index, { amountMinor: answer.unitPriceMinor, pluginId: result.pluginId, purchaseOption: option });
                continue;
            }
            if (!APP_PRICEABLE_SOURCES.has(item.priceSource)) {
                apps?.report(result.pluginId, "cart.line_prices", `Line ${answer.lineId} is priced by a ${item.priceSource} price list, which an app price never replaces; it was skipped.`);
                continue;
            }
            prices.set(item.index, { amountMinor: answer.unitPriceMinor, pluginId: result.pluginId });
        }
    }
    return prices;
}

/** Each line's add-ons, by line index (see the rules above). */
export function resolveAppLineAdjustments(
    items: ReadonlyArray<Pick<StorefrontCartValidatedItem, "index" | "isGiftCard" | "bundle">>,
    lineIds: readonly string[],
    results: ReadonlyArray<Pick<CheckoutAppFunctionResult<"cart.line_prices">, "pluginId" | "output">>,
    incrementMinor: number,
    apps?: Pick<CheckoutAppFunctions, "report">,
): Map<number, ResolvedLineProperty[]> {
    const byLineId = new Map(lineIds.map((lineId, position) => [lineId, items[position]!]));
    const adjustments = new Map<number, ResolvedLineProperty[]>();
    for (const result of results) {
        for (const answer of (result.output as PluginFunctionOutput<"cart.line_prices">).adjustments ?? []) {
            const item = byLineId.get(answer.lineId);
            if (!item) {
                apps?.report(result.pluginId, "cart.line_prices", `An add-on names line ${answer.lineId}, which is not in the cart; it was skipped.`);
                continue;
            }
            if (item.isGiftCard || item.bundle) {
                apps?.report(result.pluginId, "cart.line_prices", `Line ${answer.lineId} is ${item.isGiftCard ? "a gift card" : "part of a bundle"}, which takes no add-on; "${answer.title}" was skipped.`);
                continue;
            }
            const list = adjustments.get(item.index) ?? [];
            if (list.length >= LINE_ADJUSTMENTS_PER_LINE_MAX) {
                apps?.report(result.pluginId, "cart.line_prices", `Line ${answer.lineId} already has ${LINE_ADJUSTMENTS_PER_LINE_MAX} add-ons; "${answer.title}" was skipped.`);
                continue;
            }
            const amountMinor = roundToIncrementMinor(answer.amountMinor, incrementMinor);
            if (amountMinor <= 0) continue;
            list.push(lineAdjustmentProperty(answer.title, amountMinor));
            adjustments.set(item.index, list);
        }
    }
    return adjustments;
}

/**
 * Validates a cart with the apps' line prices and add-ons: `resolve` is the
 * cart's pure resolution from its rows. Without a pricer it runs once.
 */
export async function resolveCartWithAppLinePrices(
    pricer: AppLinePricer | undefined,
    resolve: (options: {
        appPrices?: ReadonlyMap<number, AppLinePrice>;
        appAdjustments?: ReadonlyMap<number, ResolvedLineProperty[]>;
        deferSubmittedPriceCheck?: boolean;
    }) => StorefrontCartValidationResult,
): Promise<StorefrontCartValidationResult> {
    if (!pricer) return resolve({});
    const preliminary = resolve({ deferSubmittedPriceCheck: true });
    const { prices, adjustments } = await pricer(preliminary);
    return resolve({
        ...(prices.size > 0 ? { appPrices: prices } : {}),
        ...(adjustments.size > 0 ? { appAdjustments: adjustments } : {}),
    });
}
