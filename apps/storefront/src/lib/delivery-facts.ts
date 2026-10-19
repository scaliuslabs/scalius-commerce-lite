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
  // Checkout waives the delivery fee for any order holding a free-delivery
  // product, whatever the rate or zone. The product page has no other place
  // that says so, so the fact is stated here rather than dropped.
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
  const copy = input.copy ?? catalogCopy(pageLanguage()).delivery;
  return [
    physical ? deliveryFact(rates, input.formatMoney, freeDelivery, copy) : null,
    physical
      ? pickupFact(rates, input.formatMoney, freeDelivery, copy, input.pickupAvailableText?.trim() || undefined)
      : null,
    // Nothing is handed over for a digital item, so there is no cash on delivery.
    fulfilment === "digital"
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
