/**
 * Buyer reassurance facts (delivery fees, cash on delivery, returns) derived
 * only from store data: active shipping methods, the live checkout gateway
 * configuration and the saved return policy. Nothing is claimed when the
 * underlying setting is missing or unreadable.
 */
import type { CheckoutConfig } from "./api/checkout";
import type { ProductVariant, ShippingMethod } from "./api/types";
import type { StorefrontReturnPolicySettings } from "./commerce-structured-data";

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
  /** The pickup fact's title ("Pickup available"), from the checkout language. */
  pickupAvailableText?: string;
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
  /** Rates that deliver to an address, in merchant order. */
  delivery: ShippingMethod[];
  /** Local pickup rates, offered to every buyer. */
  pickup: ShippingMethod[];
  /** Some delivery rate belongs to one delivery zone, so fees vary by address. */
  zoned: boolean;
}

/** Active, well-formed rates split by kind; shared with Product JSON-LD. */
export function splitDeliveryRates(
  shippingMethods: ShippingMethod[] | null | undefined,
): DeliveryRateSplit {
  const methods = (shippingMethods ?? [])
    .filter((method) => method.isActive !== false && Number.isFinite(method.fee) && method.fee >= 0)
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const delivery = methods.filter((method) => (method.kind ?? "delivery") === "delivery");
  return {
    delivery,
    pickup: methods.filter((method) => method.kind === "pickup"),
    zoned: delivery.some((method) => method.everywhereElse === false),
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
): DeliveryFact | null {
  const { delivery, zoned } = rates;
  if (delivery.length === 0) return null;
  // Checkout waives the delivery fee for any order holding a free-delivery
  // product, whatever the rate or zone. The product page has no other place
  // that says so, so the fact is stated here rather than dropped.
  if (freeDelivery) {
    return {
      kind: "delivery",
      title: "Free delivery",
      detail: "Delivery is free on any order with this item.",
    };
  }

  const fee = (amount: number) => (amount === 0 ? "free" : formatMoney(amount));
  const fees = delivery.map((method) => method.fee);
  const min = Math.min(...fees);
  const max = Math.max(...fees);
  if (zoned) {
    const thresholds = delivery.map((method) => method.freeOver ?? null);
    const freeOverAll = thresholds.every((value): value is number => value !== null && value > 0)
      ? [`Free over ${formatMoney(Math.max(...thresholds))}`]
      : [];
    return {
      kind: "delivery",
      title: min === 0 ? "Free delivery in some areas" : `Delivery from ${formatMoney(min)}`,
      detail: ["Price depends on your area", ...freeOverAll].join(" · "),
    };
  }

  const freeOver = (method: ShippingMethod) =>
    method.freeOver && method.fee > 0 ? `free over ${formatMoney(method.freeOver)}` : "";
  // One rate: its fee is the title, so the detail only adds what is new.
  const detail = delivery.length === 1
    ? [freeOver(delivery[0]!)].filter(Boolean)
    : delivery.slice(0, MAX_LISTED_METHODS).map((method) =>
        [`${method.name} ${fee(method.fee)}`, freeOver(method)].filter(Boolean).join(", "));
  return {
    kind: "delivery",
    title: min === max ? `Delivery ${fee(min)}` : `Delivery ${formatMoney(min)}–${formatMoney(max)}`,
    detail: detail.join(" · ").replace(/^free/, "Free"),
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
  title = "Pickup available",
): DeliveryFact | null {
  const { pickup } = rates;
  if (pickup.length === 0) return null;
  const fees = pickup.map((method) => (freeDelivery ? 0 : method.fee));
  const min = Math.min(...fees);
  const max = Math.max(...fees);
  const price = min === 0 ? "" : min === max ? formatMoney(min) : `from ${formatMoney(min)}`;
  const first = pickup[0]!;
  return {
    kind: "pickup",
    title: [title, price].filter(Boolean).join(" · "),
    detail: pickup.length === 1
      ? first.pickupAddress?.trim() || first.name
      : `${pickup.length} pickup points`,
  };
}

function codFact(
  config: CheckoutConfig | null | undefined,
  serviceDetail: string | null,
): DeliveryFact | null {
  if (!config || config.unavailable) return null;
  const cod = config.gateways.some((gateway) => gateway.flow === "cod" || gateway.id === "cod");
  if (!cod) return null;
  return {
    kind: "cod",
    title: "Cash on delivery",
    detail: serviceDetail
      ?? (config.partialPaymentEnabled
        ? "Pay a small advance online, the rest on delivery."
        : "Pay when your order arrives."),
  };
}

function returnsFact(policy: StorefrontReturnPolicySettings | null | undefined): DeliveryFact | null {
  if (!policy?.enabled) return null;
  const days = Number(policy.returnWindowDays);
  const category = policy.category;
  const title = category === "no_returns"
    ? "Final sale"
    : category === "unlimited"
      ? "Returns accepted"
      : Number.isInteger(days) && days > 0
        ? `${days}-day returns`
        : null;
  if (!title) return null;
  const detail = category === "no_returns"
    ? "Returns are not accepted."
    : policy.returnFees === "free"
      ? "Free return shipping."
      : "Return shipping is paid by the buyer.";
  const href = policy.policyUrl?.trim();
  return { kind: "returns", title, detail, ...(href ? { href } : {}) };
}

export function buildDeliveryFacts(input: DeliveryFactsInput): DeliveryFact[] {
  const rates = splitDeliveryRates(input.shippingMethods);
  const freeDelivery = input.freeDelivery === true;
  const fulfilment = input.fulfilment ?? "physical";
  const physical = fulfilment === "physical";
  return [
    physical ? deliveryFact(rates, input.formatMoney, freeDelivery) : null,
    physical
      ? pickupFact(rates, input.formatMoney, freeDelivery, input.pickupAvailableText?.trim() || undefined)
      : null,
    // Nothing is handed over for a digital item, so there is no cash on delivery.
    fulfilment === "digital"
      ? null
      : codFact(input.checkoutConfig, fulfilment === "service" ? (input.payAtServiceText?.trim() || "Pay when the service is done.") : null),
    returnsFact(input.returnPolicy),
  ].filter((fact): fact is DeliveryFact => fact !== null);
}
