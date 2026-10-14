// App line prices (`cart.line_prices`, docs/platform/PLUGINS.md): a checkout
// function's unit price for a cart line takes the app place in
// `resolvePrice()` (sale > segment > market list > app > FX > base), so B2B
// contract, subscription and tiered prices replace the catalogue price while
// market and price-list rules stay authoritative.
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
// - A line priced by a sale, segment or market list keeps that price: the
//   answer is skipped and logged for the merchant. So is a gift-card line
//   (money) and a line that is not in the cart.
// - The price rounds half-up to the market's price increment and is never
//   zero; buyer-input surcharges are added on top.

import type { Database } from "@scalius/database/client";
import type { FunctionCart, PluginFunctionOutput } from "@scalius/shared/plugins";
import type { AppLinePrice, ResolvedPriceSource } from "@scalius/shared/market-pricing";
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

/**
 * Prices a first-pass cart with the apps: the answers by line index. Built
 * per request by `createAppLinePricer`; absent when no app implements the
 * point.
 */
export type AppLinePricer = (preliminary: StorefrontCartValidationResult) => Promise<ReadonlyMap<number, AppLinePrice>>;

/** Sources whose price an app may replace: lists stay authoritative. */
const APP_PRICEABLE_SOURCES: ReadonlySet<ResolvedPriceSource> = new Set(["fx", "base"]);

export interface AppLinePricerContext {
    channel: FunctionCart["channel"];
    /** The signed-in buyer (contract prices, snapshots); a promise is awaited only when an app runs. */
    customerId?: string | null | PromiseLike<string | null>;
    /** The region the order ships to, when known. */
    destination?: { country?: string | null; city: string | null; zone: string | null } | null;
    discountCodes?: readonly string[];
}

/** The pricer for this request, or undefined when no active app implements `cart.line_prices`. */
export function createAppLinePricer(
    db: Database,
    apps: CheckoutAppFunctions | undefined,
    context: AppLinePricerContext,
): AppLinePricer | undefined {
    if (!apps?.points.has("cart.line_prices")) return undefined;
    return async (preliminary) => {
        const items = preliminary.items;
        if (items.length === 0) return new Map();
        const customerId = (await context.customerId) ?? null;
        const lineIds = items.map((item) => buildStorefrontTaxAllocationLineId(item.index, item.variantId));
        const facts = await loadAppFunctionCartFacts(db, {
            productIds: items.map((item) => item.productId),
            variantIds: items.map((item) => item.variantId),
            customerId,
            marketCountry: appCartMarketCountry(context.destination ?? null),
        });
        let cart: FunctionCart;
        try {
            cart = buildAppFunctionCart({
                currency: { code: preliminary.money.currencyCode, decimalPlaces: preliminary.money.decimalPlaces },
                channel: context.channel,
                lines: items.map((item, position) => ({
                    lineId: lineIds[position]!,
                    productId: item.productId,
                    variantId: item.variantId,
                    title: item.variantLabel ? `${item.productName} (${item.variantLabel})` : item.productName,
                    quantity: item.quantity,
                    unitPriceMinor: item.unitPriceMinor,
                    discountMinor: 0,
                    properties: item.properties,
                })),
                facts,
                destination: context.destination ?? null,
                discountCodes: context.discountCodes ?? [],
            });
        } catch (error) {
            // A cart that fails its own schema is a platform fault: no app runs (fail-open).
            console.error(`[checkout] app line-price cart could not be built: ${error instanceof Error ? error.name : "error"}`);
            return new Map();
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
        return resolveAppLinePrices(items, lineIds, results, apps);
    };
}

/** The winning app price of each line, by line index (see the rules above). */
export function resolveAppLinePrices(
    items: ReadonlyArray<Pick<StorefrontCartValidatedItem, "index" | "isGiftCard" | "priceSource">>,
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
            if (!APP_PRICEABLE_SOURCES.has(item.priceSource)) {
                apps?.report(result.pluginId, "cart.line_prices", `Line ${answer.lineId} is priced by a ${item.priceSource} price list, which an app price never replaces; it was skipped.`);
                continue;
            }
            prices.set(item.index, { amountMinor: answer.unitPriceMinor, pluginId: result.pluginId });
        }
    }
    return prices;
}

/**
 * Validates a cart with the apps' line prices: `resolve` is the cart's pure
 * resolution from its rows. Without a pricer it runs once.
 */
export async function resolveCartWithAppLinePrices(
    pricer: AppLinePricer | undefined,
    resolve: (options: { appPrices?: ReadonlyMap<number, AppLinePrice>; deferSubmittedPriceCheck?: boolean }) => StorefrontCartValidationResult,
): Promise<StorefrontCartValidationResult> {
    if (!pricer) return resolve({});
    const preliminary = resolve({ deferSubmittedPriceCheck: true });
    const appPrices = await pricer(preliminary);
    return resolve(appPrices.size > 0 ? { appPrices } : {});
}
