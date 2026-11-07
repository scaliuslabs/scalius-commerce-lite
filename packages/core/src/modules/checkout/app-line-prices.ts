import { ValidationError } from "@scalius/core/errors";
import { validateCheckoutAttributes } from "./attributes";
// App line prices (`cart.line_prices`, packages/plugin-sdk/docs/apps.md): a checkout
// function's unit price for a cart line takes the app place in
// `resolvePrice()` (purchase option > override > the lower of sale and
// segment > market list > app > FX > base), so B2B contract and tiered prices replace the catalogue price
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
// - A line bought with purchase options (at most one per app) is priced only
//   by an app whose option it carries, and that price outranks every list;
//   another app's price for it is skipped and logged. Every such app must
//   answer the line, with a valid price or a kept add-on (a protection plan
//   adds to a subscription's price), or checkout is refused, including when
//   the app fails open for other lines. Two of them pricing one line refuse
//   too (`purchase_options_conflict`): a line has one price.
// - A one-time line priced by an override, segment or market list keeps that
//   price: the answer is skipped and logged for the merchant. So is a
//   gift-card line (money) and a line that is not in the cart. Sale lines
//   accept offers so the resolver can keep the lower sale or app price.
// - A second app pricing a one-time line is not used; both apps' logs say
//   which price won, so the merchant sees the overlap (the order of apps is
//   their priority).
// - The price rounds half-up to the market's price increment and is never
//   zero; buyer-input surcharges are added on top. A price the app answers
//   in the store's currency (`currency: "store"`) converts at the checkout's
//   one rate first (`presentShopMinor`), as a product price does.
//
// Add-ons (`adjustments`, pure, `resolveAppLineAdjustments`): added to each
// unit after the whole precedence, whatever priced the line (sale, segment
// and list lines take them too). A fixed add-on rounds half-up to the cart's
// price increment, converting from the store's currency like a price; a
// share (`percent`) is taken of the item's unit price as cart validation
// prices it. Neither ever rounds to nothing (one increment). Every app's
// add-ons apply, in priority order, at most LINE_ADJUSTMENTS_PER_LINE_MAX per
// line. A gift card (money) and a line not in the cart take none (skipped and
// logged); a bundle line, or an add-on past the most a line holds, refuses
// checkout (`add_on_unavailable`), so a buyer never receives an extra
// unpaid. They ride the line as `adjustments` (the buyer sees "Add-on:
// <title>") and are frozen on the order line with its buyer inputs, so
// receipts, emails, tax, totals and refunds include them.

import type { Database } from "@scalius/database/client";
import { LINE_ADJUSTMENTS_PER_LINE_MAX, type FunctionCart, type PluginFunctionOutput } from "@scalius/shared/plugins";
import type { AppLinePrice, ResolvedPriceSource } from "@scalius/shared/market-pricing";
import { roundToIncrementMinor } from "@scalius/shared/money";
import { purchaseOptionAppId } from "@scalius/shared/plugins/ids";
import { presentShopMinor, type PresentmentMoney } from "@scalius/shared/presentment";

/** Two apps whose purchase options a line carries both priced it. */
export const PURCHASE_OPTIONS_CONFLICT_REASON = "purchase_options_conflict";
import { buildStorefrontTaxAllocationLineId } from "../tax";
import {
    CHECKOUT_APP_UNAVAILABLE_REASON,
    appCartMarketCountry,
    buildAppFunctionCart,
    functionStoreCurrency,
    loadAppFunctionCartFacts,
    type CheckoutAppFunctionResult,
    type CheckoutAppFunctions,
} from "./app-functions";
import type {
    StorefrontCartValidatedItem,
    StorefrontCartValidationResult,
} from "./cart-validation";

/** A line could not take an app's add-on (a bundle line, or past the most a line holds). */
export const ADD_ON_UNAVAILABLE_REASON = "add_on_unavailable";

/**
 * An app's add-on to each unit of a line as checkout keeps it: a fixed
 * amount, already in the cart's currency and on its increment, or a share of
 * the item's unit price, which cart validation takes once that price is
 * known (`percentOfMinor`).
 */
export type AppLineAddOn =
    | { appId: string; title: string; amountMinor: number }
    | { appId: string; title: string; percent: number };

/** The apps' answers for a cart, by line index: unit prices and add-ons. */
export interface AppLinePricing {
    prices: ReadonlyMap<number, AppLinePrice>;
    adjustments: ReadonlyMap<number, AppLineAddOn[]>;
}

const NO_APP_LINE_PRICING: AppLinePricing = { prices: new Map(), adjustments: new Map() };

/**
 * Prices a first-pass cart with the apps: the answers by line index. Built
 * per request by `createAppLinePricer`; absent when no app implements the
 * point.
 */
export type AppLinePricer = (preliminary: StorefrontCartValidationResult) => Promise<AppLinePricing>;

/** Ordinary app offers participate under sales; override, segment and market lists stay authoritative. */
const APP_PRICEABLE_SOURCES: ReadonlySet<ResolvedPriceSource> = new Set(["sale", "fx", "base"]);

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
            market: preliminary.marketContext,
            apps,
            points: ["cart.line_prices"],
            attributes,
        });
        let cart: FunctionCart;
        try {
            cart = buildAppFunctionCart({
                currency: { code: preliminary.money.currencyCode, decimalPlaces: preliminary.money.decimalPlaces },
                storeCurrency: functionStoreCurrency(preliminary.money),
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
                    purchaseOptions: (item.purchaseOptions ?? []).map((option) => option.id),
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
        return resolveAppLinePricing(items, lineIds, results, preliminary.money, apps);
    };
}

/**
 * The apps' answers for a cart (unit prices and add-ons, by line index),
 * checked against the purchase-option rule: every app whose option a line
 * carries answered it. Throws the checkout refusal otherwise.
 */
export function resolveAppLinePricing(
    items: ReadonlyArray<Pick<StorefrontCartValidatedItem, "index" | "isGiftCard" | "priceSource" | "purchaseOptions" | "bundle">>,
    lineIds: readonly string[],
    results: ReadonlyArray<Pick<CheckoutAppFunctionResult<"cart.line_prices">, "pluginId" | "output">>,
    money: PresentmentMoney,
    apps?: Pick<CheckoutAppFunctions, "report">,
): AppLinePricing {
    const pricing = {
        prices: resolveAppLinePrices(items, lineIds, results, apps, money),
        adjustments: resolveAppLineAdjustments(items, lineIds, results, money, apps),
    };
    assertPurchaseOptionPrices(items, pricing);
    return pricing;
}

/** The winning app price of each line, by line index (see the rules above). */
export function resolveAppLinePrices(
    items: ReadonlyArray<Pick<StorefrontCartValidatedItem, "index" | "isGiftCard" | "priceSource" | "purchaseOptions">>,
    lineIds: readonly string[],
    results: ReadonlyArray<Pick<CheckoutAppFunctionResult<"cart.line_prices">, "pluginId" | "output">>,
    apps?: Pick<CheckoutAppFunctions, "report">,
    /** The checkout's money: converts a price the app answered in the store's currency. Absent: every price is in the cart's. */
    money?: PresentmentMoney,
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
            if (!Number.isSafeInteger(answer.unitPriceMinor) || answer.unitPriceMinor <= 0) {
                apps?.report(result.pluginId, "cart.line_prices", `Line ${answer.lineId} has an invalid app price; it was skipped.`);
                continue;
            }
            const unitPriceMinor = answer.currency === "store" && money ? presentShopMinor(money, answer.unitPriceMinor) : answer.unitPriceMinor;
            if (item.isGiftCard) continue;
            const options = (item.purchaseOptions ?? []).map((option) => option.id);
            if (options.length > 0) {
                // An option is its app's offer: only an app whose option the line carries prices it, above every list.
                const option = options.find((candidate) => purchaseOptionAppId(candidate) === result.pluginId);
                if (!option) {
                    apps?.report(result.pluginId, "cart.line_prices", `Line ${answer.lineId} is bought with ${options.join(", ")}, which only their own apps price; it was skipped.`);
                    continue;
                }
                const taken = prices.get(item.index);
                if (taken && taken.pluginId !== result.pluginId) {
                    throw new ValidationError("These purchase options can't be combined on one item. Choose one of them.", {
                        reason: PURCHASE_OPTIONS_CONFLICT_REASON,
                    });
                }
                if (taken) continue;
                prices.set(item.index, { amountMinor: unitPriceMinor, pluginId: result.pluginId, purchaseOption: option });
                continue;
            }
            const winner = prices.get(item.index);
            if (winner) {
                // Priority decides; both apps' logs say so, so the merchant sees two apps price one item.
                if (winner.pluginId !== result.pluginId) {
                    const notice = `Line ${answer.lineId} was priced by both ${winner.pluginId} and ${result.pluginId}; ${winner.pluginId}'s price was used (it runs first).`;
                    apps?.report(result.pluginId, "cart.line_prices", notice);
                    apps?.report(winner.pluginId, "cart.line_prices", notice);
                }
                continue;
            }
            if (!APP_PRICEABLE_SOURCES.has(item.priceSource)) {
                apps?.report(result.pluginId, "cart.line_prices", `Line ${answer.lineId} is priced by a ${item.priceSource} price list, which an app price never replaces; it was skipped.`);
                continue;
            }
            prices.set(item.index, { amountMinor: unitPriceMinor, pluginId: result.pluginId });
        }
    }
    return prices;
}

/**
 * A purchase option is its owner's offer: every app whose option a line
 * carries answered it, with a valid price or a kept add-on, and the price
 * (when one was given) came from one of them. A missing answer is never
 * read as the one-time price.
 */
function assertPurchaseOptionPrices(
    items: ReadonlyArray<Pick<StorefrontCartValidatedItem, "index" | "purchaseOptions">>,
    pricing: AppLinePricing,
): void {
    for (const item of items) {
        const options = (item.purchaseOptions ?? []).map((option) => option.id);
        if (options.length === 0) continue;
        const price = pricing.prices.get(item.index);
        const validPrice = price !== undefined && Number.isSafeInteger(price.amountMinor) && price.amountMinor > 0
            && price.purchaseOption !== undefined && price.purchaseOption !== null && options.includes(price.purchaseOption)
            && price.pluginId === purchaseOptionAppId(price.purchaseOption);
        if (price && !validPrice) throw purchaseOptionUnavailable();
        const addOns = pricing.adjustments.get(item.index) ?? [];
        for (const option of options) {
            const appId = purchaseOptionAppId(option);
            const answered = (validPrice && price!.pluginId === appId) || addOns.some((addOn) => addOn.appId === appId);
            if (!answered) throw purchaseOptionUnavailable();
        }
    }
}

function purchaseOptionUnavailable(): ValidationError {
    return new ValidationError("We can't confirm this purchase option's price right now. Please try again in a few minutes.", {
        reason: CHECKOUT_APP_UNAVAILABLE_REASON,
    });
}

function addOnUnavailable(): ValidationError {
    return new ValidationError("This item can't take one of the extras chosen for it. Remove the extra to continue.", {
        reason: ADD_ON_UNAVAILABLE_REASON,
    });
}

/** Each line's add-ons, by line index (see the rules above). Throws when a line cannot take one. */
export function resolveAppLineAdjustments(
    items: ReadonlyArray<Pick<StorefrontCartValidatedItem, "index" | "isGiftCard" | "bundle">>,
    lineIds: readonly string[],
    results: ReadonlyArray<Pick<CheckoutAppFunctionResult<"cart.line_prices">, "pluginId" | "output">>,
    money: PresentmentMoney,
    apps?: Pick<CheckoutAppFunctions, "report">,
): Map<number, AppLineAddOn[]> {
    const byLineId = new Map(lineIds.map((lineId, position) => [lineId, items[position]!]));
    const adjustments = new Map<number, AppLineAddOn[]>();
    for (const result of results) {
        for (const answer of (result.output as PluginFunctionOutput<"cart.line_prices">).adjustments ?? []) {
            const item = byLineId.get(answer.lineId);
            if (!item) {
                apps?.report(result.pluginId, "cart.line_prices", `An add-on names line ${answer.lineId}, which is not in the cart; it was skipped.`);
                continue;
            }
            if (item.isGiftCard) {
                // Money takes no extras; nothing was promised to the buyer on it.
                apps?.report(result.pluginId, "cart.line_prices", `Line ${answer.lineId} is a gift card, which takes no add-on; "${answer.title}" was skipped.`);
                continue;
            }
            const list = adjustments.get(item.index) ?? [];
            if (item.bundle || list.length >= LINE_ADJUSTMENTS_PER_LINE_MAX) {
                // Dropping it would freeze the extra the buyer chose without its price.
                apps?.report(result.pluginId, "cart.line_prices", item.bundle
                    ? `Line ${answer.lineId} is part of a bundle, which takes no add-on; "${answer.title}" refused checkout.`
                    : `Line ${answer.lineId} already has ${LINE_ADJUSTMENTS_PER_LINE_MAX} add-ons; "${answer.title}" refused checkout.`);
                throw addOnUnavailable();
            }
            if ("percent" in answer) {
                list.push({ appId: result.pluginId, title: answer.title, percent: answer.percent });
            } else {
                const amountMinor = answer.currency === "store"
                    ? presentShopMinor(money, answer.amountMinor)
                    // A positive add-on never rounds to nothing: one increment, as a converted fee.
                    : Math.max(money.incrementMinor, roundToIncrementMinor(answer.amountMinor, money.incrementMinor));
                list.push({ appId: result.pluginId, title: answer.title, amountMinor });
            }
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
        appAdjustments?: ReadonlyMap<number, AppLineAddOn[]>;
        deferSubmittedPriceCheck?: boolean;
    }) => StorefrontCartValidationResult,
    phase: "before_transform" | "final" = "final",
): Promise<StorefrontCartValidationResult> {
    // Transform inputs are catalogue facts, not an orderable quote. Only the
    // final pass asks the owner and must prove every purchase-option price.
    if (phase === "before_transform") return resolve({ deferSubmittedPriceCheck: true });
    if (!pricer) {
        const result = resolve({});
        assertPurchaseOptionPrices(result.items, NO_APP_LINE_PRICING);
        return result;
    }
    const preliminary = resolve({ deferSubmittedPriceCheck: true });
    const pricing = await pricer(preliminary);
    assertPurchaseOptionPrices(preliminary.items, pricing);
    const { prices, adjustments } = pricing;
    return resolve({
        ...(prices.size > 0 ? { appPrices: prices } : {}),
        ...(adjustments.size > 0 ? { appAdjustments: adjustments } : {}),
    });
}
