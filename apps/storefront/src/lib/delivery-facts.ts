/**
 * Buyer reassurance facts (delivery fees, cash on delivery, returns) derived
 * only from store data: active shipping methods, the live checkout gateway
 * configuration and the saved return policy. Nothing is claimed when the
 * underlying setting is missing or unreadable.
 */
import type { CheckoutConfig } from "./api/checkout";
import type { ProductVariant, ShippingMethod } from "./api/types";
import type { StorefrontReturnPolicySettings } from "./commerce-structured-data";
import { catalogCopy, type CatalogCopy } from "./catalog-copy";
import { formatCount, pageLanguage } from "./store-time-zone";
import { LOCATION_COUNTRY } from "./checkout/shipping-country";

type DeliveryCopy = CatalogCopy["delivery"];

export interface DeliveryFact {
  kind: "delivery" | "pickup" | "cod" | "returns";
  title: string;
  detail: string;
  href?: string;
}

export interface DeliveryFactsInput {
  shippingMethods: ShippingMethod[] | null | undefined;
  checkoutConfig: CheckoutConfig | null | undefined;
  returnPolicy: StorefrontReturnPolicySettings | null | undefined;
  formatMoney: (amount: number) => string;
  /** The product ships free (PDP only). */
  freeDelivery?: boolean;
  /**
   * What the product page sells (PDP only). Delivery and pickup facts are
   * stated only for physical goods; a service is paid when it is done.
   */
  fulfilment?: ProductFulfilment;
  /** Cash-on-delivery wording for a service ("Pay when the service is done"). */
  payAtServiceText?: string;
  /**
   * The countries the page's market sells to (`presenceMarketCountries`):
   * only delivery to them is stated. All rates when absent.
   */
  countries?: readonly string[];
  /** The pickup fact's title ("Pickup available"), from the checkout language. */
  pickupAvailableText?: string;
  /** The facts' words; the page's language by default. */
  copy?: DeliveryCopy;
}

/** How a product reaches the buyer, for what the page may claim about delivery. */
export type ProductFulfilment = "physical" | "service" | "digital";

/**
 * Physical when some SKU is (an unknown kind is physical: it needs delivery);
 * a service when every SKU is a service; otherwise digital. Gift cards are
 * never delivered.
 */
export function productFulfilment(
  product: { isGiftCard?: boolean | null },
  variants: ReadonlyArray<Pick<ProductVariant, "fulfillmentKind">>,
): ProductFulfilment {
  if (product.isGiftCard === true) return "digital";
  const kinds = variants.map((variant) => variant.fulfillmentKind ?? "physical");
  if (kinds.length === 0 || kinds.includes("physical")) return "physical";
  return kinds.every((kind) => kind === "service") ? "service" : "digital";
}

const MAX_LISTED_METHODS = 3;
const DEFAULT_SHIPPING_PROFILE_ID = "shp_default";
/** `rateSource` of an option whose price for a product depends on its weight or order value. */
export const BANDED_RATE_SOURCE = "banded";

/**
 * The options as one product's shipping profile pays them (the checkout's
 * rule): its profile's own rates behind an option, else the option's fee
 * (the default profile's price). One unconditioned rate is a plain fee; a
 * price that depends on weight or order value is stated like a calculated
 * one (`BANDED_RATE_SOURCE`), never as a fee that may not apply.
 */
export function shippingMethodsForProfile(
  shippingMethods: ShippingMethod[] | null | undefined,
  profileId: string | null | undefined,
): ShippingMethod[] | null | undefined {
  if (!shippingMethods) return shippingMethods;
  const profile = profileId || DEFAULT_SHIPPING_PROFILE_ID;
  return shippingMethods.map((method) => {
    const rates = method.profileRates ?? [];
    const applying = profile === DEFAULT_SHIPPING_PROFILE_ID ? [] : rates.filter((rate) => rate.profileId === profile);
    if (applying.length === 0) return method;
    const [only] = applying;
    const plain = applying.length === 1 && only!.minWeightGrams === null && only!.maxWeightGrams === null
      && only!.minSubtotal === null && only!.maxSubtotal === null;
    return plain
      ? { ...method, fee: only!.fee, freeOver: only!.freeOver }
      : { ...method, fee: Math.min(...applying.map((rate) => rate.fee)), freeOver: null, rateSource: BANDED_RATE_SOURCE };
  });
}

/**
 * The options as one unit at `unitPrice` pays them: a flat option's free-over
 * amount it reaches waives the fee, as checkout does for that item alone (a
 * free-over counts the shipped items of the profile it prices). Banded and
 * calculated options are left as they are (their price is never claimed).
 */
export function shippingMethodsForUnitPrice(
  shippingMethods: ShippingMethod[] | null | undefined,
  unitPrice: number,
): ShippingMethod[] | null | undefined {
  return shippingMethods?.map((method) =>
    (!method.rateSource || method.rateSource === "flat") && typeof method.freeOver === "number" && unitPrice >= method.freeOver
      ? { ...method, fee: 0 }
      : method);
}

export interface DeliveryRateSplit {
  /** Rates that deliver to an address in the countries asked about, in merchant order. */
  delivery: ShippingMethod[];
  /** Local pickup rates, offered to every buyer. */
  pickup: ShippingMethod[];
  /**
   * The fee depends on the address: some delivery rate serves only part of
   * a country (a region, postal codes, Bangladesh delivery areas, or another
   * zone holds part of it), or the rates serve more than one country.
   */
  zoned: boolean;
}

function coverageIn(method: ShippingMethod, country: string) {
  return method.countries?.find((entry) => entry.code === country) ?? null;
}

/**
 * Active, well-formed rates split by kind; shared with Product JSON-LD and
 * the catalog feeds. With `countries`, only delivery rates whose shipping
 * zone serves one of them (MARKETS-DESIGN step 3b).
 */
export function splitDeliveryRates(
  shippingMethods: ShippingMethod[] | null | undefined,
  countries?: readonly string[],
): DeliveryRateSplit {
  const methods = (shippingMethods ?? [])
    .filter((method) => method.isActive !== false && Number.isFinite(method.fee) && method.fee >= 0)
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const asked = countries ?? [...new Set(methods.flatMap((method) => (method.countries ?? []).map((entry) => entry.code)))];
  const delivery = methods.filter((method) =>
    (method.kind ?? "delivery") === "delivery" && (!countries || countries.some((country) => coverageIn(method, country))));
  const served = asked.filter((country) => delivery.some((method) => coverageIn(method, country)));
  return {
    delivery,
    pickup: methods.filter((method) => method.kind === "pickup"),
    zoned: served.length > 1 || delivery.some((method) =>
      (method.countries ?? []).length === 0 || served.some((country) => coverageIn(method, country)?.entire === false)),
  };
}

/**
 * Whether a physical item can reach a buyer in some country of `countries`
 * at all: by a pickup rate (whatever the address), or by a delivery rate
 * whose zone serves that country where the buyer can enter an address
 * (Bangladesh's address is a city and thana, so it also needs
 * `bangladeshAddresses`: an active thana under an active city). Without
 * `countries`, every country a rate serves. The one rule for every surface
 * that claims or takes delivery: the product page's delivery and cash on
 * delivery facts and its buttons, the cart, the quick checkout and the order
 * form. When it is false a physical item cannot be ordered, so none of them
 * claims delivery or offers a form the buyer cannot finish.
 */
export function physicalDeliveryOffered(
  shippingMethods: ShippingMethod[] | null | undefined,
  countries: readonly string[] | undefined,
  bangladeshAddresses: boolean,
): boolean {
  const rates = splitDeliveryRates(shippingMethods, countries);
  if (rates.pickup.length > 0) return true;
  return rates.delivery.some((method) =>
    (method.countries ?? []).some((entry) =>
      (!countries || countries.includes(entry.code)) && (entry.code !== LOCATION_COUNTRY || bangladeshAddresses)));
}

/** Bangladesh addresses can be entered: the public config says an active thana sits under an active city. */
export function bangladeshAddressesOffered(config: CheckoutConfig | null | undefined): boolean {
  return config?.checkoutReadiness?.hasActiveDeliveryHierarchy === true;
}

/**
 * States only what holds for every buyer before an address is known. With
 * delivery zones the fee depends on the address, so the line gives the
 * lowest fee and says the price depends on the area instead of one range
 * that overstates or understates what a given buyer pays. Pickup is never a
 * delivery rate: it is stated on its own line (`pickupFact`).
 */
function deliveryFact(
  rates: DeliveryRateSplit,
  formatMoney: (amount: number) => string,
  freeDelivery: boolean,
  copy: DeliveryCopy,
): DeliveryFact | null {
  const { delivery, zoned } = rates;
  if (delivery.length === 0) return null;
  // The product's shipping profile ships it free on every rate and zone (only
  // its own share: other items pay theirs). The product page has no other
  // place that says so, so the fact is stated here rather than dropped.
  if (freeDelivery) {
    return {
      kind: "delivery",
      title: copy.freeDelivery,
      detail: copy.freeDetail,
    };
  }
  if (delivery.some((method) => method.rateSource && method.rateSource !== "flat")) {
    return {
      kind: "delivery",
      title: copy.calculated,
      detail: copy.calculatedDetail,
    };
  }

  const fee = (amount: number) => (amount === 0 ? copy.free : formatMoney(amount));
  const fees = delivery.map((method) => method.fee);
  const min = Math.min(...fees);
  const max = Math.max(...fees);
  if (zoned) {
    const thresholds = delivery.map((method) => method.freeOver ?? null);
    const freeOverAll = thresholds.every((value): value is number => value !== null && value > 0)
      ? [copy.freeOver(formatMoney(Math.max(...thresholds)))]
      : [];
    return {
      kind: "delivery",
      title: min === 0 ? copy.freeInSomeAreas : copy.from(formatMoney(min)),
      detail: [copy.dependsOnArea, ...freeOverAll].join(" · "),
    };
  }

  const freeOver = (method: ShippingMethod, first = false) =>
    method.freeOver && method.fee > 0
      ? (first ? copy.freeOver : copy.freeOverLower)(formatMoney(method.freeOver))
      : "";
  // One rate: its fee is the title, so the detail only adds what is new.
  const detail = delivery.length === 1
    ? [freeOver(delivery[0]!, true)].filter(Boolean)
    : delivery.slice(0, MAX_LISTED_METHODS).map((method) =>
        [copy.method(method.name, fee(method.fee)), freeOver(method)].filter(Boolean).join(", "));
  return {
    kind: "delivery",
    title: min === max ? copy.single(fee(min)) : copy.range(formatMoney(min), formatMoney(max)),
    detail: detail.join(" · "),
  };
}

/**
 * Local pickup on its own line, with its fee when it has one. A
 * free-delivery product waives the pickup fee too, so none is shown then.
 */
function pickupFact(
  rates: DeliveryRateSplit,
  formatMoney: (amount: number) => string,
  freeDelivery: boolean,
  copy: DeliveryCopy,
  title = "Pickup available",
): DeliveryFact | null {
  const { pickup } = rates;
  if (pickup.length === 0) return null;
  const fees = pickup.map((method) => (freeDelivery ? 0 : method.fee));
  const min = Math.min(...fees);
  const max = Math.max(...fees);
  const price = min === 0 ? "" : min === max ? formatMoney(min) : copy.pickupFrom(formatMoney(min));
  const first = pickup[0]!;
  return {
    kind: "pickup",
    title: [title, price].filter(Boolean).join(" · "),
    detail: pickup.length === 1
      ? first.pickupAddress?.trim() || first.name
      : copy.pickupPoints(formatCount(pickup.length)),
  };
}

function codFact(
  config: CheckoutConfig | null | undefined,
  serviceDetail: string | null,
  countries: readonly string[] | undefined,
  copy: DeliveryCopy,
): DeliveryFact | null {
  if (!config || config.unavailable) return null;
  const cod = config.gateways.find((gateway) => gateway.flow === "cod" || gateway.id === "cod");
  if (!cod) return null;
  // Cash on delivery serves some delivery countries (Bangladesh): claimed
  // only on a page whose market sells to one of them.
  const served = cod.countries;
  if (!serviceDetail && served && countries && !countries.some((country) => served.includes(country))) return null;
  return {
    kind: "cod",
    // A service has no delivery: the buyer pays when it is done.
    title: serviceDetail ? copy.payOnService : copy.cashOnDelivery,
    detail: serviceDetail
      ?? (config.partialPaymentEnabled ? copy.payAdvance : copy.payOnArrival),
  };
}

function returnsFact(policy: StorefrontReturnPolicySettings | null | undefined, copy: DeliveryCopy): DeliveryFact | null {
  if (!policy?.enabled) return null;
  const days = Number(policy.returnWindowDays);
  const category = policy.category;
  const title = category === "no_returns"
    ? copy.finalSale
    : category === "unlimited"
      ? copy.returnsAccepted
      : Number.isInteger(days) && days > 0
        ? copy.dayReturns(formatCount(days))
        : null;
  if (!title) return null;
  const detail = category === "no_returns"
    ? copy.noReturns
    : policy.returnFees === "free"
      ? copy.freeReturn
      : copy.buyerPaysReturn;
  const href = policy.policyUrl?.trim();
  return { kind: "returns", title, detail, ...(href ? { href } : {}) };
}

export function buildDeliveryFacts(input: DeliveryFactsInput): DeliveryFact[] {
  const rates = splitDeliveryRates(input.shippingMethods, input.countries);
  const freeDelivery = input.freeDelivery === true;
  const fulfilment = input.fulfilment ?? "physical";
  const physical = fulfilment === "physical";
  // A physical item no rate can bring to this page's buyers is neither
  // delivered nor paid on delivery: nothing about either is claimed.
  const handedOver = !physical
    || physicalDeliveryOffered(input.shippingMethods, input.countries, bangladeshAddressesOffered(input.checkoutConfig));
  const copy = input.copy ?? catalogCopy(pageLanguage()).delivery;
  return [
    physical && handedOver ? deliveryFact(rates, input.formatMoney, freeDelivery, copy) : null,
    physical && handedOver
      ? pickupFact(rates, input.formatMoney, freeDelivery, copy, input.pickupAvailableText?.trim() || undefined)
      : null,
    // Nothing is handed over for a digital item, so there is no cash on delivery.
    fulfilment === "digital" || !handedOver
      ? null
      : codFact(
        input.checkoutConfig,
        fulfilment === "service" ? (input.payAtServiceText?.trim() || "Pay when the service is done.") : null,
        input.countries,
        copy,
      ),
    returnsFact(input.returnPolicy, copy),
  ].filter((fact): fact is DeliveryFact => fact !== null);
}
