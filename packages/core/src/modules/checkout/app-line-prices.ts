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

/** Two apps whose purchase options a line carries both priced it. */
export const PURCHASE_OPTIONS_CONFLICT_REASON = "purchase_options_conflict";
import { buildStorefrontTaxAllocationLineId } from "../tax";
import {
    CHECKOUT_APP_UNAVAILABLE_REASON,
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
 * An app's add-on core did not keep: it added nothing once rounded to the
 * price increment (`nothing_to_add`), or the line takes none (a bundle line,
 * a gift card, or one that already holds the most add-ons: `not_taken`).
 */
export type AddOnSetAside = "nothing_to_add" | "not_taken";

/** The apps' answers for a cart, by line index: unit prices and add-ons. */
export interface AppLinePricing {
    prices: ReadonlyMap<number, AppLinePrice>;
    adjustments: ReadonlyMap<number, ResolvedLineProperty[]>;
    /** Add-ons core set aside, by line index and app: an owner's answer the line could not keep. */
    setAside?: ReadonlyMap<number, ReadonlyMap<string, AddOnSetAside>>;
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
        return resolveAppLinePricing(items, lineIds, results, preliminary.money.incrementMinor, apps);
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
    incrementMinor: number,
    apps?: Pick<CheckoutAppFunctions, "report">,
): AppLinePricing {
    const setAside = new Map<number, Map<string, AddOnSetAside>>();
    const pricing = {
        prices: resolveAppLinePrices(items, lineIds, results, apps),
        adjustments: resolveAppLineAdjustments(items, lineIds, results, incrementMinor, apps, setAside),
        setAside,
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
                prices.set(item.index, { amountMinor: answer.unitPriceMinor, pluginId: result.pluginId, purchaseOption: option });
                continue;
            }
            if (prices.has(item.index)) continue;
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
            if ((validPrice && price!.pluginId === appId) || addOns.some((addOn) => addOn.appId === appId)) continue;
            const aside = appId === null ? undefined : pricing.setAside?.get(item.index)?.get(appId);
            // The owner answered, and its option adds nothing to this line once rounded.
            if (aside === "nothing_to_add") continue;
            // The owner answered, but the line cannot take its add-on: waiting never helps.
            throw aside === "not_taken" ? purchaseOptionNotTaken() : purchaseOptionUnavailable();
        }
    }
}

function purchaseOptionUnavailable(): ValidationError {
    return new ValidationError("We can't confirm this purchase option's price right now. Please try again in a few minutes.", {
        reason: CHECKOUT_APP_UNAVAILABLE_REASON,
    });
}

/** The line cannot carry what its option adds (a bundle line, a gift card, the most add-ons a line holds). */
export const PURCHASE_OPTION_UNAVAILABLE_REASON = "purchase_option_unavailable";

function purchaseOptionNotTaken(): ValidationError {
    return new ValidationError("This purchase option can't be used on this item. Choose another way to buy it.", {
        reason: PURCHASE_OPTION_UNAVAILABLE_REASON,
    });
}

/** Each line's add-ons, by line index (see the rules above). */
export function resolveAppLineAdjustments(
    items: ReadonlyArray<Pick<StorefrontCartValidatedItem, "index" | "isGiftCard" | "bundle">>,
    lineIds: readonly string[],
    results: ReadonlyArray<Pick<CheckoutAppFunctionResult<"cart.line_prices">, "pluginId" | "output">>,
    incrementMinor: number,
    apps?: Pick<CheckoutAppFunctions, "report">,
    /** Filled with the add-ons core did not keep, by line index and app. */
    setAside?: Map<number, Map<string, AddOnSetAside>>,
): Map<number, ResolvedLineProperty[]> {
    const byLineId = new Map(lineIds.map((lineId, position) => [lineId, items[position]!]));
    const adjustments = new Map<number, ResolvedLineProperty[]>();
    const putAside = (index: number, appId: string, why: AddOnSetAside) => {
        if (!setAside) return;
        const line = setAside.get(index) ?? new Map<string, AddOnSetAside>();
        // A line that could not take one of the app's add-ons stays so.
        if (line.get(appId) !== "not_taken") line.set(appId, why);
        setAside.set(index, line);
    };
    for (const result of results) {
        for (const answer of (result.output as PluginFunctionOutput<"cart.line_prices">).adjustments ?? []) {
            const item = byLineId.get(answer.lineId);
            if (!item) {
                apps?.report(result.pluginId, "cart.line_prices", `An add-on names line ${answer.lineId}, which is not in the cart; it was skipped.`);
                continue;
            }
            if (item.isGiftCard || item.bundle) {
                apps?.report(result.pluginId, "cart.line_prices", `Line ${answer.lineId} is ${item.isGiftCard ? "a gift card" : "part of a bundle"}, which takes no add-on; "${answer.title}" was skipped.`);
                putAside(item.index, result.pluginId, "not_taken");
                continue;
            }
            const list = adjustments.get(item.index) ?? [];
            if (list.length >= LINE_ADJUSTMENTS_PER_LINE_MAX) {
                apps?.report(result.pluginId, "cart.line_prices", `Line ${answer.lineId} already has ${LINE_ADJUSTMENTS_PER_LINE_MAX} add-ons; "${answer.title}" was skipped.`);
                putAside(item.index, result.pluginId, "not_taken");
                continue;
            }
            const amountMinor = roundToIncrementMinor(answer.amountMinor, incrementMinor);
            if (amountMinor <= 0) {
                putAside(item.index, result.pluginId, "nothing_to_add");
                continue;
            }
            list.push(lineAdjustmentProperty(answer.title, amountMinor, result.pluginId));
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
