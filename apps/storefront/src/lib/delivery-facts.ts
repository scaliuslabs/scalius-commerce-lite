/**
 * Buyer reassurance facts (delivery fees, cash on delivery, returns) derived
 * only from store data: active shipping methods, the live checkout gateway
 * configuration and the saved return policy. Nothing is claimed when the
 * underlying setting is missing or unreadable.
 */
import type { CheckoutConfig } from "./api/checkout";
import type { ShippingMethod } from "./api/types";
import type { StorefrontReturnPolicySettings } from "./commerce-structured-data";

export interface DeliveryFact {
  kind: "delivery" | "cod" | "returns";
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
 * that overstates or understates what a given buyer pays.
 */
function deliveryFact(
  rates: DeliveryRateSplit,
  formatMoney: (amount: number) => string,
  freeDelivery: boolean,
): DeliveryFact | null {
  const { delivery, pickup, zoned } = rates;
  const fee = (amount: number) => (amount === 0 ? "free" : formatMoney(amount));
  const pickupNote = pickup.length > 0 ? ["Pickup available"] : [];

  if (delivery.length === 0) {
    if (pickup.length === 0) return null;
    const first = pickup[0]!;
    return {
      kind: "delivery",
      title: "Pickup available",
      detail: first.pickupAddress?.trim() || first.name,
    };
  }
  if (freeDelivery) {
    return { kind: "delivery", title: "Free delivery", detail: pickupNote.join(" · ") };
  }

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
      detail: ["Price depends on your area", ...freeOverAll, ...pickupNote].join(" · "),
    };
  }

  return {
    kind: "delivery",
    title: min === max ? `Delivery ${fee(min)}` : `Delivery ${formatMoney(min)}–${formatMoney(max)}`,
    detail: [
      ...delivery.slice(0, MAX_LISTED_METHODS).map((method) =>
        `${method.name} ${fee(method.fee)}${
          method.freeOver && method.fee > 0 ? `, free over ${formatMoney(method.freeOver)}` : ""
        }`),
      ...pickupNote,
    ].join(" · "),
  };
}

function codFact(config: CheckoutConfig | null | undefined): DeliveryFact | null {
  if (!config || config.unavailable) return null;
  const cod = config.gateways.some((gateway) => gateway.flow === "cod" || gateway.id === "cod");
  if (!cod) return null;
  return {
    kind: "cod",
    title: "Cash on delivery",
    detail: config.partialPaymentEnabled
      ? "Pay a small advance online, the rest on delivery."
      : "Pay when your order arrives.",
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
  return [
    deliveryFact(splitDeliveryRates(input.shippingMethods), input.formatMoney, input.freeDelivery === true),
    codFact(input.checkoutConfig),
    returnsFact(input.returnPolicy),
  ].filter((fact): fact is DeliveryFact => fact !== null);
}
