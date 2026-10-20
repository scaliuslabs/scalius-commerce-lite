// The storefront checkout price: platform discounts (promotions or bundles),
// then the apps' checkout functions, then tax. One function for the tax
// quote the buyer reviews and the order checkout prepares, so the reviewed
// total is the committed total (the quote fingerprint fences the two).
//
// With no active app implementing a point, this is exactly the platform
// pricing: no extra read and no app call.
import type { Database } from "@scalius/database/client";
import { PLUGIN_EXTENSION_RUN, type FunctionCart } from "@scalius/shared/plugins";
import type { AppProviders } from "../../integrations/provider-port";
import { fromMinor } from "@scalius/shared/money";
import type { PricingCurrency } from "@scalius/shared/currency-policy";
import { presentmentPricingCurrency, type PresentmentMoney } from "@scalius/shared/presentment";
import { ValidationError } from "@scalius/core/errors";
import { quoteStorefrontDiscount, type StorefrontDiscountQuote } from "../promotions";
import {
  buildStorefrontTaxAllocationLineId,
  calculateStorefrontTaxQuote,
  taxAddressSource,
  type StorefrontTaxAuthoritySnapshot,
  type TaxDiscountAllocationInput,
  type TaxQuote,
} from "../tax";
import { DELIVERY_HIERARCHY_COUNTRY } from "@scalius/shared/markets";
import { DELIVERY_RATE_UNAVAILABLE_REASON, deliveryRateInCurrency, destinationCountry, listDeliveryRatesForDestination, type DeliveryRateRow } from "../delivery";
import { BUILT_IN_PAYMENT_PROVIDERS, COD_LABEL, NET_TERMS_LABEL, NET_TERMS_PAYMENT_METHOD, type PaymentProviders } from "../payments";
import { GIFT_CARD_PAYMENT_METHOD } from "../gift-cards";
import type { StorefrontOrderShippingMethodSnapshot } from "../orders";
import { resolveBundlePromotionInterplay, type BundlePromotionInterplay } from "./bundle-discounts";
import type { StorefrontCartValidationResult } from "./cart-validation";
import {
  applyAppPaymentMethodOperations,
  applyAppShippingRateOperations,
  appCartMarketCountry,
  buildAppFunctionCart,
  CHECKOUT_RULES_FAILED_REASON,
  collectCheckoutRuleErrors,
  combineDiscountAllocations,
  loadAppFunctionCartFacts,
  resolveAppDiscounts,
  wantsAppCart,
  type AppDiscountResolution,
  type AppliedAppDiscount,
  type AppObjectCommit,
  type CheckoutAppFunctions,
  type CheckoutPaymentMethodOption,
  type CheckoutRateOption,
  type CheckoutRuleError,
  PAYMENT_METHOD_UNAVAILABLE_REASON,
} from "./app-functions";

/** The delivery facts pricing needs (a delivery preflight result has them). */
export interface CheckoutPricingDelivery {
  rateRows?: DeliveryRateRow[];
  kind: "delivery" | "pickup" | null;
  shippingMinor: number;
  shippingMethod: StorefrontOrderShippingMethodSnapshot | null;
  cityName: string | null;
  zoneName: string | null;
  areaName: string | null;
  /** A delivery rate's destination (its zone holds the rate); null for pickup or nothing physical. */
  address: {
    countryCode?: string;
    city: string | null;
    zone: string | null;
    area: string | null;
    adminArea?: string | null;
    postalCode?: string | null;
  } | null;
  fulfilment: { requiresShipping: boolean };
}

export interface StorefrontCheckoutPricingInput {
  cartValidation: Pick<StorefrontCartValidationResult, "items" | "subtotalMinor" | "hasFreeDeliveryProduct"> & {
    /** The cart's currency (its market's): every amount is priced in it (MARKETS-DESIGN step 6). */
    money?: PresentmentMoney;
  };
  delivery: CheckoutPricingDelivery;
  discountCodes: readonly string[];
  attributes?: Record<string, string>;
  customerId?: string | null;
  /** The signed-in account whose segments may unlock segment-limited promotions (never a guest). */
  segmentCustomerId?: string | null;
  customerPhone?: string | null;
  /**
   * The shop currency at the store's price increment. A cart priced in a
   * market's own currency (`cartValidation.money`) prices in that currency at
   * its increment instead.
   */
  currency: PricingCurrency;
  taxAuthority?: StorefrontTaxAuthoritySnapshot;
  apps?: CheckoutAppFunctions;
  /** The request's app providers: an app tax provider is asked through them (none: it fails closed). */
  appProviders?: AppProviders;
  channel: FunctionCart["channel"];
  /**
   * Where tax regions locate the billing address of an order that ships
   * nothing (`taxAddressSource`): its country, admin area code and postal
   * code. Ignored for an order that ships (taxed at its shipping address)
   * and for pickup (taxed where it is collected).
   */
  billing?: { countryCode: string; adminArea: string | null; postalCode: string | null } | null;
  /** The buyer's destination, to list the options a shipping-rates app may adjust. */
  location?: {
    countryCode?: string | null;
    city?: string | null;
    zone?: string | null;
    area?: string | null;
    adminArea?: string | null;
    postalCode?: string | null;
  } | null;
}

export interface StorefrontCheckoutPricing {
  /** Tax allocation line id per validated item, in cart order. */
  lineIds: string[];
  /** The platform discount (promotions; none when bundles won), codes an app answers to removed from `rejectedCodes`. */
  discount: StorefrontDiscountQuote;
  /**
   * The typed codes' verdict before the bundle interplay: what an order
   * asserts (`assertDiscountCodesApplied`), so a code the bundle saving beat
   * is still a valid code.
   */
  typedCodes: StorefrontDiscountQuote;
  bundleDiscountMinor: number;
  bundleLines: BundlePromotionInterplay["bundleLines"];
  appDiscounts: AppliedAppDiscount[];
  /** Snapshot writes the applied app discounts commit with the order. */
  appObjectCommits: AppObjectCommit[];
  /** The delivery charge before discounts (an app may have priced the chosen rate). */
  shippingMinor: number;
  /** The chosen rate as the buyer sees it (an app may have renamed or priced it). */
  shippingMethod: StorefrontOrderShippingMethodSnapshot | null;
  taxQuote: TaxQuote;
  /** App rules the cart breaks: checkout is blocked while any remain. */
  ruleErrors: CheckoutRuleError[];
  /** The delivery options to show when an app changed them; null when none did. */
  shippingRates: CheckoutRateOption[] | null;
  /** The cart apps saw; null when no app implements a cart point. */
  appCart: FunctionCart | null;
}

/** Delivery options in the decimal HTTP contract (refusal details and the quote). */
export function presentCheckoutRateOptions(rates: readonly CheckoutRateOption[], decimalPlaces: number) {
  return rates.map((rate) => ({
    id: rate.rateId,
    name: rate.name,
    kind: rate.kind,
    amount: fromMinor(rate.amountMinor, decimalPlaces),
    amountMinor: rate.amountMinor,
  }));
}

async function listRateOptions(
  db: Database,
  input: StorefrontCheckoutPricingInput,
): Promise<CheckoutRateOption[]> {
  // The destination's zone decides the delivery options (MARKETS-DESIGN step 3b).
  const source = input.delivery.address ?? input.location ?? null;
  const country = destinationCountry(source);
  // Bangladesh needs its city; another country is a destination by itself.
  const hasDestination = country === DELIVERY_HIERARCHY_COUNTRY ? Boolean(source?.city?.trim()) : Boolean(source);
  const money = input.cartValidation.money;
  const rows = (input.delivery.rateRows ?? await listDeliveryRatesForDestination(db, hasDestination
    ? {
      countryCode: country,
      city: source?.city,
      zone: source?.zone,
      area: source?.area,
      adminArea: source?.adminArea,
      postalCode: source?.postalCode,
    }
    : null)).map((row) => deliveryRateInCurrency(row, money));
  return rows
    // Without a destination only pickup is offered; apps adjust what the buyer can choose.
    .filter((row) => (hasDestination || row.kind === "pickup") && (!row.rateSource || row.rateSource === "flat" || row.rateCurrency !== undefined))
    .map((row) => {
      const freeOver = row.freeOverMinor ?? null;
      const waived = input.cartValidation.hasFreeDeliveryProduct
        || (freeOver !== null && input.cartValidation.subtotalMinor >= freeOver);
      return {
        rateId: row.id,
        name: row.name.trim(),
        kind: row.kind === "pickup" ? "pickup" as const : "delivery" as const,
        amountMinor: waived ? 0 : row.feeMinor,
        baseAmountMinor: row.feeMinor,
        waived,
      };
    });
}

/** A cart that fails its own schema is a platform fault: no app runs (fail-open), checkout goes on. */
function safeAppCart(build: () => FunctionCart): FunctionCart | null {
  try {
    return build();
  } catch (error) {
    console.error(`[checkout] app cart could not be built: ${error instanceof Error ? error.name : "error"}`);
    return null;
  }
}

export async function priceStorefrontCheckout(
  db: Database,
  input: StorefrontCheckoutPricingInput,
): Promise<StorefrontCheckoutPricing> {
  const { cartValidation, delivery } = input;
  // The cart's currency prices everything (promotions, apps, tax).
  const currency = cartValidation.money ? presentmentPricingCurrency(cartValidation.money) : input.currency;
  const apps = input.apps;
  const lineIds = cartValidation.items.map((item) => buildStorefrontTaxAllocationLineId(item.index, item.variantId));

  const platformPricing = async (shippingMinor: number) => {
    const discount = await quoteStorefrontDiscount(db, {
      codes: [...input.discountCodes],
      customerId: input.customerId,
      segmentCustomerId: input.segmentCustomerId ?? null,
      customerPhone: input.customerPhone,
      cart: {
        currencyCode: currency.code,
        priceIncrementMinor: currency.priceIncrementMinor,
        // Shop-currency amounts of a promotion convert at the locked rate (Shopify).
        ...(cartValidation.money && cartValidation.money.currencyCode !== cartValidation.money.shopCurrencyCode
          ? { money: cartValidation.money }
          : {}),
        lines: cartValidation.items.map((item, position) => ({
          id: lineIds[position]!,
          productId: item.productId,
          variantId: item.variantId,
          unitPriceMinor: item.unitPriceMinor,
          quantity: item.quantity,
          // Gift-card lines are outside every promotion (§4.2).
          ...(item.isGiftCard ? { giftCard: true } : {}),
        })),
        shippingAmountMinor: shippingMinor,
      },
    });
    // Promotions or quantity bundles price the order, never both (bundle-discounts.ts).
    return {
      typed: discount,
      ...resolveBundlePromotionInterplay(
        cartValidation.items.map((item, position) => ({
          lineId: lineIds[position]!,
          unitPriceMinor: item.unitPriceMinor,
          quantity: item.quantity,
          bundleDiscountMinor: item.bundleDiscountMinor ?? 0,
        })),
        discount,
      ),
    };
  };

  let shippingMinor = delivery.shippingMinor;
  let shippingMethod = delivery.shippingMethod;
  let platform = await platformPricing(shippingMinor);
  let appDiscounts: AppliedAppDiscount[] = [];
  let appObjectCommits: AppObjectCommit[] = [];
  let claimedCodes: string[] = [];
  let ruleErrors: CheckoutRuleError[] = [];
  let shippingRates: CheckoutRateOption[] | null = delivery.rateRows ? await listRateOptions(db, input) : null;
  let appCart: FunctionCart | null = null;

  if (apps && wantsAppCart(apps, ["cart.validate", "checkout.discounts", "checkout.shipping_rates", "checkout.payment_methods", PLUGIN_EXTENSION_RUN])) {
    const wantsRates = apps.points.has("checkout.shipping_rates") && delivery.kind !== null && shippingMethod !== null;
    const appDestination = delivery.fulfilment.requiresShipping
      ? { country: delivery.address?.countryCode ?? null, city: delivery.cityName, zone: delivery.zoneName }
      : null;
    const [facts, rateOptions] = await Promise.all([
      loadAppFunctionCartFacts(db, {
        productIds: cartValidation.items.map((item) => item.productId),
        variantIds: cartValidation.items.map((item) => item.variantId),
        customerId: input.customerId,
        // An order that ships nothing is placed in its billing country, where it is taxed.
        marketCountry: appCartMarketCountry(appDestination, input.billing?.countryCode),
        // The apps' declared reads for every point this cart is asked at ride the same batch.
        apps,
        points: ["cart.validate", "checkout.discounts", "checkout.shipping_rates", "checkout.payment_methods", PLUGIN_EXTENSION_RUN],
        attributes: input.attributes,
      }),
      wantsRates ? listRateOptions(db, input) : Promise.resolve([] as CheckoutRateOption[]),
    ]);
    const platformLine = new Map((platform.allocation?.lines ?? []).map((line) => [line.lineId, line.amountMinor]));
    appCart = safeAppCart(() => buildAppFunctionCart({
      currency,
      channel: input.channel,
      lines: cartValidation.items.map((item, position) => ({
        lineId: lineIds[position]!,
        productId: item.productId,
        variantId: item.variantId,
        title: item.variantLabel ? `${item.productName} (${item.variantLabel})` : item.productName,
        quantity: item.quantity,
        unitPriceMinor: item.unitPriceMinor,
        discountMinor: platformLine.get(lineIds[position]!) ?? 0,
        properties: item.properties,
      })),
      facts,
      destination: appDestination,
      discountCodes: input.discountCodes,
      attributes: input.attributes,
    }));
    const cart = appCart;
    // One wave of app calls: every point sees the same cart.
    const [validations, discounts, rates] = !cart ? [[], [], []] as const : await Promise.all([
      apps.points.has("cart.validate") ? apps.run("cart.validate", { cart }) : Promise.resolve([]),
      apps.points.has("checkout.discounts") ? apps.run("checkout.discounts", { cart }) : Promise.resolve([]),
      wantsRates && rateOptions.length > 0
        ? apps.run("checkout.shipping_rates", {
          cart,
          rates: rateOptions.slice(0, 50).map((rate) => ({ rateId: rate.rateId, name: rate.name.slice(0, 80), amountMinor: rate.amountMinor, kind: rate.kind })),
        })
        : Promise.resolve([]),
    ]);
    ruleErrors = collectCheckoutRuleErrors(
      validations,
      new Map(cartValidation.items.map((item, position) => [lineIds[position]!, { index: item.index, cartKey: item.cartKey ?? null }])),
      apps,
    );

    if (rates.length > 0 && shippingMethod) {
      const adjusted = applyAppShippingRateOperations(rateOptions, rates, currency.priceIncrementMinor, apps);
      if (adjusted.changed) {
        shippingRates = adjusted.rates;
        const chosen = adjusted.rates.find((rate) => rate.rateId === shippingMethod!.id);
        if (!chosen && rateOptions.some((rate) => rate.rateId === shippingMethod!.id)) {
          throw new ValidationError(
            "This delivery option isn't available for this order. Choose another delivery option.",
            { reason: DELIVERY_RATE_UNAVAILABLE_REASON, shippingRates: presentCheckoutRateOptions(adjusted.rates, currency.decimalPlaces) },
          );
        }
        if (chosen) {
          shippingMethod = {
            ...shippingMethod,
            name: chosen.name,
            baseAmountMinor: chosen.baseAmountMinor,
            feeWaived: chosen.waived,
          };
          if (chosen.amountMinor !== shippingMinor) {
            shippingMinor = chosen.amountMinor;
            // Delivery discounts follow the charge the buyer now pays.
            platform = await platformPricing(shippingMinor);
          }
        }
      }
    }

    if (discounts.length > 0) {
      const platformLines = new Map((platform.allocation?.lines ?? []).map((line) => [line.lineId, line.amountMinor]));
      const resolution = resolveAppDiscounts({
        currencyCode: currency.code,
        priceIncrementMinor: currency.priceIncrementMinor,
        lines: cartValidation.items.map((item, position) => ({
          lineId: lineIds[position]!,
          grossMinor: item.unitPriceMinor * item.quantity,
          platformDiscountMinor: platformLines.get(lineIds[position]!) ?? 0,
          giftCard: item.isGiftCard,
        })),
        shippingMinor,
        platformShippingDiscountMinor: platform.allocation?.shippingMinor ?? 0,
        submittedCodes: input.discountCodes,
        results: discounts,
        apps,
      });
      appDiscounts = resolution.applied;
      appObjectCommits = resolution.commits;
      claimedCodes = resolution.claimedCodes;
    }
  }

  // A code only an app answers to is not "not found" any more.
  const withoutClaimed = (quote: StorefrontDiscountQuote): StorefrontDiscountQuote => claimedCodes.length > 0
    ? {
      ...quote,
      rejectedCodes: quote.rejectedCodes.filter((rejection) =>
        !(rejection.reason === "not_found" && claimedCodes.includes(rejection.code.trim().toUpperCase()))),
    }
    : quote;
  const discount = withoutClaimed(platform.discount);

  // The taxed address (Shopify's rule): the shipping address of an order
  // that ships; the billing address of one that ships nothing; else (pickup,
  // or no billing address) where the store ships from.
  const addressSource = taxAddressSource({
    deliveryKind: delivery.fulfilment.requiresShipping ? "delivery" : delivery.kind === "pickup" ? "pickup" : null,
    hasBillingAddress: Boolean(input.billing?.countryCode),
  });
  const taxAddress = addressSource === "shipping" ? delivery.address : null;
  const billing = addressSource === "billing" ? input.billing! : null;
  const taxQuoteInput = {
    destination: {
      city: taxAddress?.city ?? null,
      zone: taxAddress?.zone ?? null,
      area: taxAddress?.area ?? null,
      cityName: delivery.cityName,
      zoneName: delivery.zoneName,
      areaName: delivery.areaName,
      ...(taxAddress ? {
        countryCode: destinationCountry(taxAddress),
        adminArea: taxAddress.adminArea ?? null,
        postalCode: taxAddress.postalCode ?? null,
      } : {}),
      ...(billing ? {
        countryCode: billing.countryCode,
        adminArea: billing.adminArea,
        postalCode: billing.postalCode,
      } : {}),
    },
    ...(billing ? { addressSource: "billing" as const } : {}),
    lines: cartValidation.items.map((item, position) => ({
      lineId: lineIds[position]!,
      productId: item.productId,
      variantId: item.variantId,
      unitPriceMinor: item.unitPriceMinor,
      quantity: item.quantity,
      taxClassId: item.taxClassId,
      // A gift card is money, not a taxable sale (§4.2).
      ...(item.isGiftCard ? { taxExempt: true } : {}),
    })),
    shippingMinor,
    // Tax follows every discount: the platform's and the apps'.
    promotionDiscountAllocation: combineDiscountAllocations(platform.allocation, appDiscounts),
    currency,
  };
  const taxQuote = await calculateStorefrontTaxQuote(db, taxQuoteInput, input.taxAuthority, { apps: input.appProviders });

  return {
    lineIds,
    discount,
    typedCodes: withoutClaimed(platform.typed),
    bundleDiscountMinor: platform.bundleDiscountMinor,
    bundleLines: platform.bundleLines,
    appDiscounts,
    appObjectCommits,
    shippingMinor,
    shippingMethod,
    taxQuote,
    ruleErrors,
    shippingRates,
    appCart,
  };
}

/** The refusal when app rules block checkout (quote and order alike). */
export function assertNoCheckoutRuleErrors(ruleErrors: readonly CheckoutRuleError[]): void {
  if (ruleErrors.length === 0) return;
  throw new ValidationError(
    ruleErrors.length === 1 && ruleErrors[0]!.index === null
      ? ruleErrors[0]!.message
      : "Some items in your cart need attention.",
    { reason: CHECKOUT_RULES_FAILED_REASON, ruleErrors },
  );
}

/**
 * The cart page's `cart.validate` check: the same app cart at catalog
 * totals (discounts are priced by the checkout quote, which runs the rules
 * again with them, as does the order). No app implementing the point: no read.
 */
export async function checkStorefrontCartRules(
  db: Database,
  input: {
    cartValidation: Pick<StorefrontCartValidationResult, "items">;
    /** The chosen delivery, when the cart has one: apps see its region. */
    delivery: (Pick<CheckoutPricingDelivery, "cityName" | "zoneName" | "fulfilment"> & {
      address?: Pick<NonNullable<CheckoutPricingDelivery["address"]>, "countryCode"> | null;
    }) | null;
    apps: CheckoutAppFunctions | undefined;
    currency: { code: string; decimalPlaces: number };
    customerId?: string | null;
    channel: FunctionCart["channel"];
    attributes?: Record<string, string>;
    onCart?: (cart: FunctionCart) => void;
  },
): Promise<CheckoutRuleError[]> {
  const { apps, cartValidation } = input;
  if ((!apps?.points.has("cart.validate") && !apps?.points.has(PLUGIN_EXTENSION_RUN)) || cartValidation.items.length === 0) return [];
  const lineIds = cartValidation.items.map((item) => buildStorefrontTaxAllocationLineId(item.index, item.variantId));
  const destination = input.delivery?.fulfilment.requiresShipping
    ? { country: input.delivery.address?.countryCode ?? null, city: input.delivery.cityName, zone: input.delivery.zoneName }
    : null;
  const facts = await loadAppFunctionCartFacts(db, {
    productIds: cartValidation.items.map((item) => item.productId),
    variantIds: cartValidation.items.map((item) => item.variantId),
    customerId: input.customerId,
    marketCountry: appCartMarketCountry(destination),
    apps,
    points: ["cart.validate", PLUGIN_EXTENSION_RUN],
    attributes: input.attributes,
  });
  const cart = safeAppCart(() => buildAppFunctionCart({
    currency: input.currency,
    channel: input.channel,
    lines: cartValidation.items.map((item, position) => ({
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
    destination,
    discountCodes: [],
    attributes: input.attributes,
  }));
  if (!cart) return [];
  input.onCart?.(cart);
  if (!apps?.points.has("cart.validate")) return [];
  return collectCheckoutRuleErrors(
    await apps.run("cart.validate", { cart }),
    new Map(cartValidation.items.map((item, position) => [lineIds[position]!, { index: item.index, cartKey: item.cartKey ?? null }])),
    apps,
  );
}

/**
 * The cart's discount preview (`POST /discounts/validate`) with the apps'
 * discounts stacked the way checkout stacks them. Prices are the cart's own
 * (a preview); the checkout quote is authoritative. Null when no app
 * implements `checkout.discounts` (no read, no call).
 */
export async function previewStorefrontAppDiscounts(
  db: Database,
  input: {
    apps: CheckoutAppFunctions | undefined;
    currency: PricingCurrency;
    lines: ReadonlyArray<{ lineId: string; productId: string; variantId: string; unitPriceMinor: number; quantity: number; giftCard?: boolean }>;
    platformAllocation: TaxDiscountAllocationInput | undefined;
    shippingMinor: number;
    discountCodes: readonly string[];
    /** The channel apps see (a buyer agent's cart previews as "agent"). */
    channel?: FunctionCart["channel"];
  },
): Promise<AppDiscountResolution | null> {
  const { apps } = input;
  if (!apps?.points.has("checkout.discounts") || input.lines.length === 0) return null;
  const facts = await loadAppFunctionCartFacts(db, {
    productIds: input.lines.map((line) => line.productId),
    variantIds: input.lines.map((line) => line.variantId),
    // A preview knows no address: the backup market.
    marketCountry: null,
    apps,
    points: ["checkout.discounts"],
  });
  const platformLines = new Map((input.platformAllocation?.lines ?? []).map((line) => [line.lineId, line.amountMinor]));
  const cart = safeAppCart(() => buildAppFunctionCart({
    currency: input.currency,
    channel: input.channel ?? "online_store",
    lines: input.lines.map((line) => ({
      lineId: line.lineId,
      productId: line.productId,
      variantId: line.variantId,
      title: "",
      quantity: line.quantity,
      unitPriceMinor: line.unitPriceMinor,
      discountMinor: platformLines.get(line.lineId) ?? 0,
      properties: [],
    })),
    facts,
    destination: null,
    discountCodes: input.discountCodes,
  }));
  if (!cart) return null;
  return resolveAppDiscounts({
    currencyCode: input.currency.code,
    priceIncrementMinor: input.currency.priceIncrementMinor,
    lines: input.lines.map((line) => ({
      lineId: line.lineId,
      grossMinor: line.unitPriceMinor * line.quantity,
      platformDiscountMinor: platformLines.get(line.lineId) ?? 0,
      giftCard: line.giftCard,
    })),
    shippingMinor: input.shippingMinor,
    platformShippingDiscountMinor: input.platformAllocation?.shippingMinor ?? 0,
    submittedCodes: input.discountCodes,
    results: await apps.run("checkout.discounts", { cart }),
    apps,
  });
}

/** A payment method's buyer-facing name (the gateway's checkout name; cash on delivery; the invoice). */
export function checkoutPaymentMethodName(methodId: string, providers: PaymentProviders = BUILT_IN_PAYMENT_PROVIDERS): string {
  if (methodId === "cod") return COD_LABEL;
  if (methodId === NET_TERMS_PAYMENT_METHOD) return NET_TERMS_LABEL;
  return providers.get(methodId)?.checkoutName?.trim() || methodId;
}

/**
 * The payment methods to offer after the apps (`checkout.payment_methods`):
 * the methods checkout already allows, narrowed, renamed and reordered.
 * `changed` is false when no app changed anything (then show the list as is).
 * A `gated` method (net terms whose merchant lets apps decide) is shown only
 * when an app allows it; with no app answering it stays hidden.
 */
export async function resolveAppPaymentMethods(
  apps: CheckoutAppFunctions | undefined,
  cart: FunctionCart | null,
  methodIds: readonly string[],
  providers: PaymentProviders = BUILT_IN_PAYMENT_PROVIDERS,
  gated: ReadonlySet<string> = NO_GATED_METHODS,
): Promise<{ methods: CheckoutPaymentMethodOption[]; changed: boolean }> {
  const methods = [...new Set(methodIds)].map((methodId) => ({ methodId, name: checkoutPaymentMethodName(methodId, providers) }));
  if (!apps?.points.has("checkout.payment_methods") || !cart || methods.length === 0) {
    return { methods: methods.filter((method) => !gated.has(method.methodId)), changed: false };
  }
  const results = await apps.run("checkout.payment_methods", {
    cart,
    methods: methods.slice(0, 20).map((method) => ({
      methodId: method.methodId.slice(0, 128),
      name: method.name.slice(0, 80),
      ...(gated.has(method.methodId) ? { gated: true as const } : {}),
    })),
  });
  return applyAppPaymentMethodOperations(methods, results, apps, gated);
}

const NO_GATED_METHODS: ReadonlySet<string> = new Set();

/** Order placement: an app may have hidden the chosen method for this cart. Gift cards are tender, never hidden. */
export async function assertStorefrontAppPaymentMethod(
  apps: CheckoutAppFunctions | undefined,
  cart: FunctionCart | null,
  chosen: string,
  methodIds: readonly string[],
  providers: PaymentProviders = BUILT_IN_PAYMENT_PROVIDERS,
  /** Methods an app must allow (gated net terms); the chosen one is refused unless one did. */
  gated: ReadonlySet<string> = NO_GATED_METHODS,
): Promise<void> {
  if (chosen === GIFT_CARD_PAYMENT_METHOD || !methodIds.includes(chosen)) return;
  const { methods, changed } = await resolveAppPaymentMethods(apps, cart, methodIds, providers, gated);
  if ((changed || gated.has(chosen)) && !methods.some((method) => method.methodId === chosen)) {
    throw new ValidationError(
      "This payment method isn't available for this order. Choose another.",
      { reason: PAYMENT_METHOD_UNAVAILABLE_REASON },
    );
  }
}

/**
 * The rate a quote in a market's own currency converts shop amounts at
 * (MARKETS-DESIGN step 6), for the buyer to see: the shop currency, the rate
 * (presentment units per shop unit), when it was set and until when an order
 * placed now keeps it. Null for a shop-currency quote.
 */
export function presentQuoteFx(money: PresentmentMoney | null | undefined, now: Date = new Date()) {
  if (!money || money.currencyCode === money.shopCurrencyCode) return null;
  return {
    shopCurrencyCode: money.shopCurrencyCode,
    rate: money.rate,
    source: money.fxSource,
    asOf: money.fxAsOf === null ? null : new Date(money.fxAsOf * 1_000).toISOString(),
    lockedUntil: new Date(now.getTime() + money.lockMinutes * 60_000).toISOString(),
  };
}
