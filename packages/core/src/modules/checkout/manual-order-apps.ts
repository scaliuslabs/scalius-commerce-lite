// Checkout app functions on staff-created (manual) orders, channel "admin".
// The merge rules are checkout's (app-functions.ts); this file only says what
// a manual order feeds them, so the same cart gets the same outcome as on the
// online store. It implements `ManualOrderAppFunctions`
// (`@scalius/shared/checkout-app-facts`): the API builds one per request with
// `createManualOrderAppFunctions` and passes it to the orders module's quote
// and create, so orders never depends on checkout. Amendments never run
// apps: an order an app discounted is not amendable (orders/admin/amend.ts),
// like a promotion order.
//
// - `cart.validate`: any rule error refuses the quote and the order, with the
//   checkout refusal's shape (`details.reason` = `cart_rules`, `ruleErrors`
//   with the line index of the form).
// - `checkout.discounts`: the staff discount takes the place of promotions in
//   stacking rule 1: it is spread over the lines by value (gift-card lines
//   excluded) exactly as the tax quote spreads it, and apps see each line's
//   total after it. App discounts apply after it, from what is left, and the
//   tax quote takes both allocations together. A manual order has no codes,
//   so a code-driven app discount never applies. The order records each app
//   discount as an `app_discount` fact, as a storefront order does.
// - `checkout.shipping_rates`: runs only when the order uses a delivery method
//   (a custom charge has no rate to adjust). Apps see the rates the store
//   offers for the address, the chosen one at the charge the order carries.
//   Hiding the chosen method refuses the order with the storefront's reason
//   (`delivery_rate_unavailable`, the options left in `shippingRates`). A
//   rename becomes the method name the order keeps. A price applies only
//   when staff kept the method's own fee: a charge that differs from the fee
//   is an explicit staff override and stands. (The dashboard's form fills
//   the fee when a method is picked and drops the method when staff type a
//   charge, so there a typed charge never meets an app price.) Manual orders
//   do not waive fees, so no rate is "waived" here.
// - `checkout.payment_methods`: manual orders are cash on delivery, the one
//   method apps see. An app that hides it refuses the quote and the order
//   (`payment_method_unavailable`), as checkout refuses a hidden method.
//
// With no active app implementing a cart point there is no read and no call.

import type { Database } from "@scalius/database/client";
import type { FunctionCart } from "@scalius/shared/plugins";
import type {
    ManualOrderAppFunctions,
    ManualOrderAppInput,
    ManualOrderAppLine,
    ManualOrderAppOutcome,
} from "@scalius/shared/checkout-app-facts";
import { ValidationError } from "@scalius/core/errors";
import { LINE_PURCHASE_OPTION_PROPERTY_KEY, readLinePurchaseOption } from "@scalius/shared/line-properties";
import {
    applyAppPaymentMethodOperations,
    applyAppShippingRateOperations,
    appCartMarketCountry,
    buildAppFunctionCart,
    checkoutPurchaseOptions,
    CHECKOUT_RULES_FAILED_REASON,
    collectCheckoutRuleErrors,
    combineDiscountAllocations,
    loadAppFunctionCartFacts,
    PAYMENT_METHOD_UNAVAILABLE_REASON,
    resolveAppDiscounts,
    wantsAppCart,
    type AppFunctionCartFacts,
    type CheckoutAppFunctions,
    type CheckoutRateOption,
} from "./app-functions";
import { checkoutPaymentMethodName, presentCheckoutRateOptions } from "./pricing";
import { DELIVERY_HIERARCHY_COUNTRY } from "@scalius/shared/markets";
import { DELIVERY_RATE_UNAVAILABLE_REASON, listDeliveryRatesForDestination } from "../delivery";
import { buildStorefrontDiscountAllocation, type TaxDiscountAllocationInput } from "../tax";

/** A manual order's default payment method (staff may also choose an invoice, `net_terms`). */
export const MANUAL_ORDER_PAYMENT_METHOD = "cod";

/** The apps' checkout functions on staff orders, bound to this request's database and apps. */
export function createManualOrderAppFunctions(db: Database, apps: CheckoutAppFunctions): ManualOrderAppFunctions {
    return {
        price: (input) => applyManualOrderAppFunctions(db, apps, input),
        purchaseOptions: checkoutPurchaseOptions(apps),
    };
}

const PRICING_POINTS = ["cart.validate", "checkout.discounts", "checkout.shipping_rates", "checkout.payment_methods"] as const;

function parseLineInputs(serialized: string | null): Array<{ key: string; value: string }> {
    if (!serialized) return [];
    try {
        const parsed: unknown = JSON.parse(serialized);
        if (!Array.isArray(parsed)) return [];
        return parsed.flatMap((entry: unknown) => {
            if (!entry || typeof entry !== "object") return [];
            const { key, value } = entry as { key?: unknown; value?: unknown };
            // The purchase option is the line's own field, not a buyer input.
            if (key === LINE_PURCHASE_OPTION_PROPERTY_KEY) return [];
            return typeof key === "string" && typeof value === "string" ? [{ key, value }] : [];
        });
    } catch {
        return [];
    }
}

/** The staff discount spread over the lines, exactly as the tax quote spreads it. */
function manualDiscountAllocation(lines: readonly ManualOrderAppLine[], discountMinor: number): TaxDiscountAllocationInput {
    return buildStorefrontDiscountAllocation({
        discountMinor,
        lines: lines
            .filter((line) => !line.isGiftCard)
            .map((line) => ({ lineId: line.lineId, unitPriceMinor: line.unitPriceMinor, quantity: line.quantity })),
    }).allocation;
}

type CartSource = Pick<ManualOrderAppInput, "currency" | "lines" | "requiresShipping" | "shippingCountryCode" | "locationNames" | "channel" | "salesChannelId">;

/** Where a manual order ships; null when it ships nothing. */
function destinationOf(input: CartSource) {
    return input.requiresShipping
        ? { country: input.shippingCountryCode ?? null, city: input.locationNames.cityName, zone: input.locationNames.zoneName }
        : null;
}

function loadCartFacts(db: Database, input: CartSource, apps?: CheckoutAppFunctions) {
    return loadAppFunctionCartFacts(db, {
        productIds: input.lines.map((line) => line.productId),
        variantIds: input.lines.map((line) => line.variantId),
        // A staff order belongs to no signed-in account: apps see a guest, as at a guest checkout.
        customerId: null,
        marketCountry: appCartMarketCountry(destinationOf(input)),
        ...(apps ? { apps, points: PRICING_POINTS } : {}),
    });
}

/** The app cart of a manual order: line totals after the staff discount, before the apps'. */
function cartOf(
    input: CartSource,
    facts: AppFunctionCartFacts,
    platformLine: ReadonlyMap<string, number>,
): FunctionCart {
    return buildAppFunctionCart({
        currency: input.currency,
        channel: input.channel ?? "admin",
        // The channel the create resolved (staff's pick, else the online store).
        salesChannelId: input.salesChannelId,
        // A staff order belongs to no signed-in account: no segments.
        lines: input.lines.map((line) => ({
            lineId: line.lineId,
            productId: line.productId,
            variantId: line.variantId,
            title: line.variantLabel ? `${line.productName} (${line.variantLabel})` : line.productName,
            quantity: line.quantity,
            unitPriceMinor: line.unitPriceMinor,
            discountMinor: platformLine.get(line.lineId) ?? 0,
            properties: parseLineInputs(line.properties),
            purchaseOption: readLinePurchaseOption(line.properties),
        })),
        facts,
        destination: destinationOf(input),
        discountCodes: [],
    });
}

/** The rates the store offers for the order's address, the chosen one at the order's charge. */
async function listRateOptions(
    db: Database,
    input: ManualOrderAppInput,
    chosen: NonNullable<ManualOrderAppInput["deliveryMethod"]>,
): Promise<CheckoutRateOption[]> {
    // The destination's zone decides the options, as at checkout: Bangladesh
    // by its City/Thana/Area, another country by its regions.
    const foreign = input.requiresShipping && input.shippingCountryCode && input.shippingCountryCode !== DELIVERY_HIERARCHY_COUNTRY;
    const destination = input.address
        ? { countryCode: DELIVERY_HIERARCHY_COUNTRY, ...input.address }
        : foreign
            ? { countryCode: input.shippingCountryCode, adminArea: input.shippingAdminArea, postalCode: input.shippingPostalCode }
            : null;
    const rows = await listDeliveryRatesForDestination(db, destination);
    const options: CheckoutRateOption[] = rows
        // Without a destination only pickup is offered (the storefront's rule).
        .filter((row) => destination || row.kind === "pickup")
        .map((row) => ({
            rateId: row.id,
            name: row.name.trim(),
            kind: row.kind === "pickup" ? "pickup" as const : "delivery" as const,
            amountMinor: row.id === chosen.id ? input.shippingMinor : row.feeMinor,
            baseAmountMinor: row.feeMinor,
            waived: false,
        }));
    // Staff may use a method this address would not list (another zone's rate).
    if (!options.some((option) => option.rateId === chosen.id)) {
        options.push({
            rateId: chosen.id,
            name: chosen.name.trim(),
            kind: chosen.kind,
            amountMinor: input.shippingMinor,
            baseAmountMinor: chosen.feeMinor,
            waived: false,
        });
    }
    return options;
}

/** Apps' rules, delivery options, payment method and discounts on a manual order (see the header). */
export async function applyManualOrderAppFunctions(
    db: Database,
    apps: CheckoutAppFunctions,
    input: ManualOrderAppInput,
): Promise<ManualOrderAppOutcome> {
    const none: ManualOrderAppOutcome = {
        shippingMinor: input.shippingMinor,
        deliveryMethod: input.deliveryMethod,
        appDiscounts: [],
        discountAllocation: undefined,
    };
    if (!wantsAppCart(apps, PRICING_POINTS) || input.lines.length === 0) return none;

    const manual = manualDiscountAllocation(input.lines, input.manualDiscountMinor);
    const platformLine = new Map(manual.lines.map((line) => [line.lineId, line.amountMinor]));
    const chosenMethod = input.deliveryMethod;
    const wantsRates = apps.points.has("checkout.shipping_rates") && chosenMethod !== null;
    const [facts, rateOptions] = await Promise.all([
        loadCartFacts(db, input, apps),
        wantsRates ? listRateOptions(db, input, chosenMethod) : Promise.resolve([] as CheckoutRateOption[]),
    ]);
    let cart: FunctionCart;
    try {
        cart = cartOf(input, facts, platformLine);
    } catch (error) {
        // A cart that fails its own schema is a platform fault: no app runs (fail-open).
        console.error(`[orders] manual order app cart could not be built: ${error instanceof Error ? error.name : "error"}`);
        return none;
    }
    const paymentMethod = input.paymentMethod ?? MANUAL_ORDER_PAYMENT_METHOD;
    const methods = [{ methodId: paymentMethod, name: checkoutPaymentMethodName(paymentMethod) }];

    // One wave of app calls: every point sees the same cart.
    const [validations, discounts, rates, payments] = await Promise.all([
        apps.points.has("cart.validate") ? apps.run("cart.validate", { cart }) : Promise.resolve([]),
        apps.points.has("checkout.discounts") ? apps.run("checkout.discounts", { cart }) : Promise.resolve([]),
        wantsRates && rateOptions.length > 0
            ? apps.run("checkout.shipping_rates", {
                cart,
                rates: rateOptions.slice(0, 50).map((rate) => ({ rateId: rate.rateId, name: rate.name.slice(0, 80), amountMinor: rate.amountMinor, kind: rate.kind })),
            })
            : Promise.resolve([]),
        apps.points.has("checkout.payment_methods")
            ? apps.run("checkout.payment_methods", { cart, methods })
            : Promise.resolve([]),
    ]);

    let shippingMinor = input.shippingMinor;
    let deliveryMethod = chosenMethod;
    if (rates.length > 0 && chosenMethod) {
        const adjusted = applyAppShippingRateOperations(rateOptions, rates, input.currency.priceIncrementMinor, apps);
        if (adjusted.changed) {
            const chosen = adjusted.rates.find((rate) => rate.rateId === chosenMethod.id);
            if (!chosen) {
                throw new ValidationError(
                    "An app doesn't offer this delivery method for this order. Choose another delivery method or set a custom charge.",
                    { reason: DELIVERY_RATE_UNAVAILABLE_REASON, shippingRates: presentCheckoutRateOptions(adjusted.rates, input.currency.decimalPlaces) },
                );
            }
            // Staff kept the method's own fee: an app's price applies. Otherwise the typed charge stands.
            const priced = input.shippingMinor === chosenMethod.feeMinor;
            deliveryMethod = {
                ...chosenMethod,
                name: chosen.name,
                feeMinor: priced ? chosen.baseAmountMinor : chosenMethod.feeMinor,
            };
            if (priced) shippingMinor = chosen.amountMinor;
        }
    }

    const ruleErrors = collectCheckoutRuleErrors(
        validations,
        new Map(input.lines.map((line, index) => [line.lineId, { index, cartKey: null }])),
        apps,
    );
    if (ruleErrors.length > 0) {
        throw new ValidationError(
            ruleErrors.length === 1 && ruleErrors[0]!.index === null
                ? ruleErrors[0]!.message
                : "Some items in this order break an app's rules.",
            { reason: CHECKOUT_RULES_FAILED_REASON, ruleErrors },
        );
    }

    if (payments.length > 0) {
        const offered = applyAppPaymentMethodOperations(methods, payments, apps);
        if (offered.changed && !offered.methods.some((method) => method.methodId === paymentMethod)) {
            throw new ValidationError(
                paymentMethod === MANUAL_ORDER_PAYMENT_METHOD
                    ? "An app doesn't allow cash on delivery for this order."
                    : "An app doesn't allow paying later by invoice for this order.",
                { reason: PAYMENT_METHOD_UNAVAILABLE_REASON },
            );
        }
    }

    const resolution = discounts.length > 0
        ? resolveAppDiscounts({
            currencyCode: input.currency.code,
            priceIncrementMinor: input.currency.priceIncrementMinor,
            lines: input.lines.map((line) => ({
                lineId: line.lineId,
                grossMinor: line.unitPriceMinor * line.quantity,
                platformDiscountMinor: platformLine.get(line.lineId) ?? 0,
                giftCard: line.isGiftCard,
            })),
            shippingMinor,
            platformShippingDiscountMinor: 0,
            submittedCodes: [],
            results: discounts,
            // The staff discount is an order discount (rule 10).
            platformClasses: input.manualDiscountMinor > 0 ? ["order"] : [],
            apps,
        })
        : null;
    const appDiscounts = resolution?.applied ?? [];
    return {
        shippingMinor,
        deliveryMethod,
        appDiscounts,
        discountAllocation: appDiscounts.length > 0 ? combineDiscountAllocations(manual, appDiscounts) : undefined,
    };
}
