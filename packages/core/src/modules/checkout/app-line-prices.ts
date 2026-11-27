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
//   in the store's currency (`currency: "store"`) converts exactly as a
//   product price does (`storeAmountMinor`, the catalogue's `fxPriceMinor` at
//   the checkout's one rate: rate, adjustment, rounding and ending).
//
// Add-ons (`addOns`, pure, `resolveAppLineAdjustments`): added to each
// unit after the whole precedence, whatever priced the line (sale, segment
// and list lines take them too). A fixed add-on rounds half-up to the cart's
// price increment; one in the store's currency converts at the checkout's
// rate with the market's adjustment, but without its rounding step or
// ending (`storeAmountMinor`: those are the item's price point); a
// share (`percent`) is taken of the item's unit price as cart validation
// prices it. Neither ever rounds to nothing (one increment); a fixed 0 is a free
// extra, recorded on the line. Every app's
// add-ons apply, in priority order, at most LINE_ADJUSTMENTS_PER_LINE_MAX per
// line. A gift card (money) and a line not in the cart take none (skipped and
// logged); an add-on past the most a line holds refuses checkout
// (`add_on_unavailable`), so a buyer never receives an extra unpaid. An
// add-on on any component of an expanded bundle (`cart.transform` expand)
// is the bundle's: one fee per bundle unit, charged on its anchor (the
// component holding the fewest per bundle unit) at the fee over that
// component's units per bundle unit, the same app's same-titled answer on
// another component counted once; cart validation prices it once every
// component is priced. Merged lines keep their own add-ons, as plain lines. They ride the line as `adjustments` (the buyer sees "Add-on:
// <title>") and are frozen on the order line with its buyer inputs, so
// receipts, emails, tax, totals and refunds include them.

import type { Database } from "@scalius/database/client";
import { LINE_ADJUSTMENT_MAX_MINOR, LINE_ADJUSTMENTS_PER_LINE_MAX, type FunctionCart, type PluginFunctionOutput } from "@scalius/shared/plugins";
import { LINE_ADD_ONS_SERIALIZED_MAX, lineAdjustmentProperty } from "@scalius/shared/line-properties";
import { storeAmountMinor, type AppLinePrice, type ResolvedPriceSource, type StoreAmountConversion } from "@scalius/shared/market-pricing";
import { addOnShareMinor, roundToIncrementMinor } from "@scalius/shared/money";
import { purchaseOptionAppId } from "@scalius/shared/plugins/ids";

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

/** A line could not take an app's add-on (past the most a line holds, or more than an order line keeps). */
export const ADD_ON_UNAVAILABLE_REASON = "add_on_unavailable";

/**
 * An app's add-on to each unit of a line as checkout keeps it, exactly as
 * answered: a fixed amount in the cart's or the store's currency, never yet
 * rounded or converted, or a share of the item's unit price. Cart validation
 * charges it once it knows the line (`addOnChargeMinor`), so it is rounded
 * exactly once, to the step the line can carry.
 */
export type AppLineAddOn =
    | { appId: string; title: string; amountMinor: number; currency: "cart" | "store"; bundle?: AppLineAddOnBundle; details?: string[] }
    | { appId: string; title: string; percent: number; bundle?: AppLineAddOnBundle; details?: string[] };

/**
 * A bundle's add-on, on its anchor line: the amount (or share of the bundle
 * unit's price) is per bundle unit, and the anchor holds `perUnit` units of
 * each bundle unit.
 */
export interface AppLineAddOnBundle {
    id: string;
    perUnit: number;
}

/** The apps' answers for a cart, by line index: unit prices and add-ons; a kit's price by its bundle id. */
export interface AppLinePricing {
    prices: ReadonlyMap<number, AppLinePrice>;
    adjustments: ReadonlyMap<number, AppLineAddOn[]>;
    /** Tells an app's log what checkout charged for one of its add-ons when it is not what it answered (once a message). */
    report?: AddOnReport;
    /** A store kit is one line to apps: its price (the kit SKU's), split over its items by checkout. */
    kitPrices?: ReadonlyMap<string, AppLinePrice>;
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
        // A store kit is one line to apps: its own SKU and product, its units and price (`kitAppLines`).
        const { items, kits } = kitAppLines(preliminary.items);
        if (items.length === 0) return NO_APP_LINE_PRICING;
        const customerId = (await context.customerId) ?? null;
        // A kit's line is the buyer's kit line (its bundle id).
        const lineIds = items.map((item) => (item.index < 0 ? kits[-1 - item.index]!.bundleId : buildStorefrontTaxAllocationLineId(item.index, item.variantId)));
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
                currency: { code: preliminary.money.currencyCode, decimalPlaces: preliminary.money.decimalPlaces, priceIncrementMinor: preliminary.money.incrementMinor },
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
                    bundle: item.index < 0 ? kits[-1 - item.index]!.bundle : item.bundle,
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
                // The same item in the store's currency: a rule in it prices once, core converts once.
                ...(item.storeUnitPriceMinor !== undefined
                    ? { storeUnitPrice: { amountMinor: item.storeUnitPriceMinor, currency: cart.storeCurrency.code } }
                    : {}),
                bundle: item.bundle ? { id: item.bundle.id, title: item.bundle.title.slice(0, 300), units: item.bundle.units } : null,
            })),
        });
        // What checkout charges is known only as it lays the lines out: it tells each app once a message.
        const told = new Set<string>();
        const report: AddOnReport = (appId, message) => {
            if (told.has(`${appId}\u0000${message}`)) return;
            told.add(`${appId}\u0000${message}`);
            apps.report(appId, "cart.line_prices", message);
        };
        return { ...kitPricing(resolveAppLinePricing(items, lineIds, results, storeAmountConversionOf(preliminary), apps), kits, preliminary.items), report };
    };
}

/** A kit's one line to apps: the bundle it stands for and the line index it takes (negative, never a real line). */
export interface KitAppLine {
    bundleId: string;
    index: number;
    /** How the function cart names it: a kit's one line. */
    bundle: { id: string; title: string; kind: "kit"; units: number; kit: { variantId: string; productId: string }; merged: true };
}

/**
 * The lines apps price: every line as it is, except a store kit's items,
 * which are one line (`lineId` the buyer's kit line, the kit SKU and product,
 * its units, its price, the bundle's inputs and options). An app's price for
 * an item's SKU never reaches inside a kit; its price for the kit's SKU is the
 * kit's (`kitPricing`).
 */
export function kitAppLines(lines: readonly StorefrontCartValidatedItem[]): { items: StorefrontCartValidatedItem[]; kits: KitAppLine[] } {
    const items: StorefrontCartValidatedItem[] = [];
    const kits: KitAppLine[] = [];
    const seen = new Set<string>();
    const anchors = bundleAnchors(lines);
    for (const line of lines) {
        const bundle = line.bundle;
        if (!bundle?.kit) {
            items.push(line);
            continue;
        }
        if (seen.has(bundle.id)) continue;
        seen.add(bundle.id);
        const anchor = lines.find((candidate) => candidate.index === anchors.get(bundle.id)?.index) ?? line;
        const index = -1 - kits.length;
        const units = Math.max(1, bundle.units ?? 1);
        kits.push({ bundleId: bundle.id, index, bundle: { id: bundle.id, title: bundle.title, kind: "kit", units, kit: { variantId: bundle.kit.variantId, productId: bundle.kit.productId }, merged: true } });
        items.push({
            ...anchor,
            index,
            productId: bundle.kit.productId,
            variantId: bundle.kit.variantId,
            productName: bundle.title,
            variantLabel: null,
            quantity: units,
            unitPriceMinor: bundle.kit.unitPriceMinor,
            baseUnitPriceMinor: bundle.kit.unitPriceMinor,
            ...(bundle.kit.storeUnitPriceMinor !== undefined ? { storeUnitPriceMinor: bundle.kit.storeUnitPriceMinor } : { storeUnitPriceMinor: undefined }),
            priceSource: bundle.kit.priceSource ?? "base",
            propertiesPriceMinor: 0,
            properties: bundle.properties ?? [],
            adjustments: undefined,
            bundle: null,
            isGiftCard: false,
        });
    }
    return { items, kits };
}

/** The apps' answers with each kit line's put where checkout reads them: its price by bundle, its add-ons on its anchor once per kit unit. */
function kitPricing(pricing: AppLinePricing, kits: readonly KitAppLine[], lines: readonly StorefrontCartValidatedItem[]): AppLinePricing {
    if (kits.length === 0) return pricing;
    const anchors = bundleAnchors(lines);
    const prices = new Map(pricing.prices);
    const adjustments = new Map(pricing.adjustments);
    const kitPrices = new Map<string, AppLinePrice>();
    for (const kit of kits) {
        const price = prices.get(kit.index);
        prices.delete(kit.index);
        if (price) kitPrices.set(kit.bundleId, price);
        const addOns = adjustments.get(kit.index);
        adjustments.delete(kit.index);
        const anchor = anchors.get(kit.bundleId);
        if (!addOns || !anchor) continue;
        adjustments.set(anchor.index, [...(adjustments.get(anchor.index) ?? []), ...addOns.map((addOn) => ({ ...addOn, bundle: { id: kit.bundleId, perUnit: anchor.perUnit } }))]);
    }
    return { prices, adjustments, kitPrices };
}

/** How a validated cart converts an app's store-currency amounts: its money and its market's FX policy. */
export function storeAmountConversionOf(result: Pick<StorefrontCartValidationResult, "money" | "marketAuthority">): StoreAmountConversion {
    return { money: result.money, fx: result.marketAuthority?.market?.fx ?? null };
}

/**
 * The apps' answers for a cart (unit prices and add-ons, by line index),
 * checked against the purchase-option rule: every app whose option a line
 * carries answered it. Throws the checkout refusal otherwise.
 */
export function resolveAppLinePricing(
    items: ReadonlyArray<Pick<StorefrontCartValidatedItem, "index" | "isGiftCard" | "priceSource" | "purchaseOptions" | "bundle" | "quantity">>,
    lineIds: readonly string[],
    results: ReadonlyArray<Pick<CheckoutAppFunctionResult<"cart.line_prices">, "pluginId" | "output">>,
    conversion: StoreAmountConversion,
    apps?: Pick<CheckoutAppFunctions, "report">,
): AppLinePricing {
    const pricing = {
        prices: resolveAppLinePrices(items, lineIds, results, apps, conversion),
        adjustments: resolveAppLineAdjustments(items, lineIds, results, apps),
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
    /** How the checkout converts a price the app answered in the store's currency. Absent: every price is in the cart's. */
    conversion?: StoreAmountConversion,
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
            const unitPriceMinor = answer.currency === "store" && conversion ? storeAmountMinor(answer.unitPriceMinor, conversion, "price") : answer.unitPriceMinor;
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
    items: ReadonlyArray<Pick<StorefrontCartValidatedItem, "index" | "purchaseOptions"> & Partial<Pick<StorefrontCartValidatedItem, "bundle">>>,
    pricing: AppLinePricing,
): void {
    const kitsChecked = new Set<string>();
    for (const item of items) {
        const options = (item.purchaseOptions ?? []).map((option) => option.id);
        if (options.length === 0) continue;
        // A kit's items carry its options: the kit is answered once, as one line (its price, or an add-on on its anchor).
        const kit = item.bundle?.kit ? item.bundle.id : null;
        if (kit && kitsChecked.has(kit)) continue;
        if (kit) kitsChecked.add(kit);
        const price = kit ? pricing.kitPrices?.get(kit) : pricing.prices.get(item.index);
        const validPrice = price !== undefined && Number.isSafeInteger(price.amountMinor) && price.amountMinor > 0
            && price.purchaseOption !== undefined && price.purchaseOption !== null && options.includes(price.purchaseOption)
            && price.pluginId === purchaseOptionAppId(price.purchaseOption);
        if (price && !validPrice) throw purchaseOptionUnavailable();
        const addOns = kit
            ? [...pricing.adjustments.values()].flat().filter((addOn) => addOn.bundle?.id === kit)
            : pricing.adjustments.get(item.index) ?? [];
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

export function addOnUnavailable(): ValidationError {
    return new ValidationError("This item can't take one of the extras chosen for it. Remove the extra to continue.", {
        reason: ADD_ON_UNAVAILABLE_REASON,
    });
}

/** Writes one line to an app's log about one of its add-ons (`cart.line_prices`). */
export type AddOnReport = (appId: string, message: string) => void;

/**
 * The step an add-on is charged in on a line: the market's increment times
 * the units the line carrying it holds per bundle unit (1 on a plain or
 * merged line; an expanded bundle's or a kit's anchor holds `perUnit`), so
 * every unit of that line pays the same exact amount.
 */
export function addOnStepMinor(perUnit: number, incrementMinor: number): number {
    if (!Number.isSafeInteger(perUnit) || perUnit < 1) throw addOnUnavailable();
    return perUnit * incrementMinor;
}

/**
 * What an app's add-on charges, the one rounding checkout and the per-line
 * slot's offers both use: per unit of a plain line (`perUnit` 1), per bundle
 * unit on a bundle's anchor. A fixed amount in the cart's currency, a
 * store-currency amount (converted at the checkout's rate with the market's
 * adjustment, `storeAmountMinor`) or a share of `basisMinor` (the item's
 * unit price, or the bundle unit's) is rounded ONCE, half-up, to the line's
 * step (`addOnStepMinor`): ৳351 over a pair of teas at whole taka is ৳352
 * (৳176 a tea), ৳350.50 there ৳350. It moves at most half a step either way,
 * except that a positive amount never becomes free: one below half a step
 * charges one step. A free extra (0) stays 0. Returns the amount per unit of
 * the plain line or per bundle unit, a multiple of the step.
 */
export function addOnChargeMinor(addOn: AppLineAddOn, basisMinor: number, perUnit: number, conversion: StoreAmountConversion): number {
    const step = addOnStepMinor(perUnit, conversion.money.incrementMinor);
    if ("percent" in addOn) return addOnShareMinor(basisMinor, addOn.percent, step);
    if (addOn.amountMinor === 0) return 0;
    if (addOn.currency === "store") return storeAmountMinor(addOn.amountMinor, { ...conversion, money: { ...conversion.money, incrementMinor: step } }, "add_on");
    return Math.max(step, roundToIncrementMinor(addOn.amountMinor, step));
}

/**
 * Tells the app's log when checkout charges an add-on other than it answered
 * (`addOnChargeMinor`): a cart-currency amount off the line's step, or any
 * add-on a bundle's step moved from what a plain line would charge. Names the
 * answer, the charge and the step, so the app can answer multiples of it.
 */
export function reportAddOnCharge(report: AddOnReport | undefined, addOn: AppLineAddOn, chargedMinor: number, basisMinor: number, perUnit: number, conversion: StoreAmountConversion): void {
    if (!report) return;
    const step = perUnit * conversion.money.incrementMinor;
    const where = perUnit > 1 ? `per bundle unit (its anchor holds ${perUnit} a bundle unit, so the step is ${step} minor units)` : `per unit (the market's step is ${step} minor units)`;
    if (!("percent" in addOn) && addOn.currency === "cart") {
        if (chargedMinor !== addOn.amountMinor) report(addOn.appId, `"${addOn.title}" answered ${addOn.amountMinor} minor units was charged ${chargedMinor} ${where}; answer a multiple of the step to be charged exactly.`);
        return;
    }
    if (perUnit === 1) return;
    const plain = addOnChargeMinor(addOn, basisMinor, 1, conversion);
    if (plain !== chargedMinor) {
        const answered = "percent" in addOn ? `${addOn.percent}% (${plain} minor units on a plain line)` : `${addOn.amountMinor} store minor units (${plain} on a plain line)`;
        report(addOn.appId, `"${addOn.title}" answered ${answered} was charged ${chargedMinor} ${where}; answer a multiple of the step to be charged exactly.`);
    }
}

/**
 * Each bundle's anchor: the line of the bundle holding the fewest units per
 * bundle unit (the first in the cart on a tie), and that number.
 */
export function bundleAnchors(items: ReadonlyArray<Pick<StorefrontCartValidatedItem, "index" | "quantity" | "bundle">>): Map<string, { index: number; perUnit: number }> {
    const anchors = new Map<string, { index: number; perUnit: number }>();
    for (const item of items) {
        if (item.bundle?.kind !== "expand" || !item.bundle.units) continue;
        const perUnit = item.quantity / item.bundle.units;
        const current = anchors.get(item.bundle.id);
        if (!current || perUnit < current.perUnit) anchors.set(item.bundle.id, { index: item.index, perUnit });
    }
    return anchors;
}

/** Each line's add-ons, by line index (see the rules above). Throws when a line cannot take one. */
export function resolveAppLineAdjustments(
    items: ReadonlyArray<Pick<StorefrontCartValidatedItem, "index" | "isGiftCard" | "bundle" | "quantity">>,
    lineIds: readonly string[],
    results: ReadonlyArray<Pick<CheckoutAppFunctionResult<"cart.line_prices">, "pluginId" | "output">>,
    apps?: Pick<CheckoutAppFunctions, "report">,
): Map<number, AppLineAddOn[]> {
    const byLineId = new Map(lineIds.map((lineId, position) => [lineId, items[position]!]));
    const anchors = bundleAnchors(items);
    const bundleFees = new Set<string>();
    const adjustments = new Map<number, AppLineAddOn[]>();
    const frozenBytes = new Map<number, number>();
    for (const result of results) {
        for (const answer of (result.output as PluginFunctionOutput<"cart.line_prices">).addOns ?? []) {
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
            // An expanded bundle's add-on rides its anchor, once per bundle unit:
            // the same extra answered on each component is the same extra.
            const anchor = item.bundle?.kind === "expand" ? anchors.get(item.bundle.id) : undefined;
            const bundle = item.bundle && anchor ? { id: item.bundle.id, perUnit: anchor.perUnit } : undefined;
            if (bundle) {
                const fee = `${result.pluginId}\u0000${bundle.id}\u0000${answer.title}`;
                if (bundleFees.has(fee)) {
                    apps?.report(result.pluginId, "cart.line_prices", `Line ${answer.lineId} is part of bundle ${bundle.id}, which already takes "${answer.title}" once per bundle unit; this answer was counted once.`);
                    continue;
                }
                bundleFees.add(fee);
            }
            const target = anchor?.index ?? item.index;
            const list = adjustments.get(target) ?? [];
            if (list.length >= LINE_ADJUSTMENTS_PER_LINE_MAX) {
                // Dropping it would freeze the extra the buyer chose without its price.
                apps?.report(result.pluginId, "cart.line_prices", `Line ${answer.lineId} already has ${LINE_ADJUSTMENTS_PER_LINE_MAX} add-ons; "${answer.title}" refused checkout.`);
                throw addOnUnavailable();
            }
            // What the order line will freeze for it, at its largest amount: the line's add-ons stay within their share of the snapshot.
            const frozen = (frozenBytes.get(target) ?? 0) + JSON.stringify(lineAdjustmentProperty(answer.title, LINE_ADJUSTMENT_MAX_MINOR, result.pluginId, answer.details)).length + 1;
            if (frozen > LINE_ADD_ONS_SERIALIZED_MAX) {
                apps?.report(result.pluginId, "cart.line_prices", `Line ${answer.lineId}'s add-ons would be more than an order line keeps; "${answer.title}" refused checkout.`);
                throw addOnUnavailable();
            }
            frozenBytes.set(target, frozen);
            // The app's detail lines ride the add-on to the order line: what its summary row opens to.
            const details = answer.details?.length ? { details: [...answer.details] } : {};
            // Kept as answered: cart validation rounds (and converts) it once, to the line's step (`addOnChargeMinor`).
            if ("percent" in answer) {
                list.push({ appId: result.pluginId, title: answer.title, percent: answer.percent, ...(bundle ? { bundle } : {}), ...details });
            } else {
                list.push({ appId: result.pluginId, title: answer.title, amountMinor: answer.amountMinor, currency: answer.currency ?? "cart", ...(bundle ? { bundle } : {}), ...details });
            }
            adjustments.set(target, list);
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
        kitPrices?: ReadonlyMap<string, AppLinePrice>;
        deferSubmittedPriceCheck?: boolean;
        reportAddOn?: AddOnReport;
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
    const { prices, adjustments, kitPrices, report } = pricing;
    return resolve({
        ...(prices.size > 0 ? { appPrices: prices } : {}),
        ...(adjustments.size > 0 ? { appAdjustments: adjustments, ...(report ? { reportAddOn: report } : {}) } : {}),
        ...(kitPrices && kitPrices.size > 0 ? { kitPrices } : {}),
    });
}
