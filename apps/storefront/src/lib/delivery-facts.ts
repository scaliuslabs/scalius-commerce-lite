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

function deliveryFact(
  methods: ShippingMethod[],
  formatMoney: (amount: number) => string,
  freeDelivery: boolean,
): DeliveryFact | null {
  if (methods.length === 0) return null;
  const listed = methods.slice(0, MAX_LISTED_METHODS);
  if (freeDelivery) {
    return {
      kind: "delivery",
      title: "Free delivery",
      detail: listed.map((method) => method.name).join(" · "),
    };
  }
  const fees = methods.map((method) => method.fee);
  const min = Math.min(...fees);
  const max = Math.max(...fees);
  return {
    kind: "delivery",
    title: min === max
      ? `Delivery ${min === 0 ? "free" : formatMoney(min)}`
      : `Delivery ${formatMoney(min)}–${formatMoney(max)}`,
    detail: listed
      .map((method) => `${method.name} ${method.fee === 0 ? "free" : formatMoney(method.fee)}`)
      .join(" · "),
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
  const methods = (input.shippingMethods ?? [])
    .filter((method) => method.isActive && Number.isFinite(method.fee) && method.fee >= 0)
    .sort((a, b) => a.sortOrder - b.sortOrder);
  return [
    deliveryFact(methods, input.formatMoney, input.freeDelivery === true),
    codFact(input.checkoutConfig),
    returnsFact(input.returnPolicy),
  ].filter((fact): fact is DeliveryFact => fact !== null);
}
