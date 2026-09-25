/**
 * The three checkout paths (Wave A §2.7):
 *
 * - `delivery`: something physical ships to the buyer's address (address,
 *   city, thana and a delivery rate are required);
 * - `pickup`: physical items are collected at the store (a pickup rate only;
 *   no address is asked, sent or stored);
 * - `none`: nothing physical was bought (services): no delivery method, no
 *   fee, no address — "we'll send updates to your phone".
 *
 * Phone is required on every path. The form's mode is only what the buyer
 * chose: the API decides from the SKUs and the rate's kind, and ignores an
 * address sent for a pickup or service order. The same tables drive the
 * browser field checks and the no-JS form path (`lib/cart/server.ts`).
 */
import type { DeliveryMethodKind } from "@scalius/shared/fulfilment";

export const CHECKOUT_DELIVERY_MODES = ["delivery", "pickup", "none"] as const;
export type CheckoutDeliveryMode = (typeof CHECKOUT_DELIVERY_MODES)[number];

export function isCheckoutDeliveryMode(value: unknown): value is CheckoutDeliveryMode {
  return typeof value === "string" && (CHECKOUT_DELIVERY_MODES as readonly string[]).includes(value);
}

/**
 * The path for a cart: `none` when nothing needs a delivery method,
 * otherwise the chosen method's kind (delivery until one is chosen).
 */
export function resolveCheckoutDeliveryMode(
  needsDeliveryMethod: boolean,
  chosen: DeliveryMethodKind | null | undefined,
): CheckoutDeliveryMode {
  if (!needsDeliveryMethod) return "none";
  return chosen === "pickup" ? "pickup" : "delivery";
}

/** Form fields a buyer must fill; `shippingMethod` is the chosen rate. */
export type CheckoutRequiredField =
  | "customerName"
  | "customerPhone"
  | "shippingAddress"
  | "city"
  | "zone"
  | "shippingMethod";

export const CHECKOUT_REQUIRED_FIELDS: Readonly<Record<CheckoutDeliveryMode, readonly CheckoutRequiredField[]>> = {
  delivery: ["customerName", "customerPhone", "shippingAddress", "city", "zone", "shippingMethod"],
  pickup: ["customerName", "customerPhone", "shippingMethod"],
  none: ["customerName", "customerPhone"],
};

export function isCheckoutFieldRequired(
  mode: CheckoutDeliveryMode,
  field: CheckoutRequiredField,
): boolean {
  return CHECKOUT_REQUIRED_FIELDS[mode].includes(field);
}

/** The required fields left empty, in form order. */
export function missingCheckoutFields(
  mode: CheckoutDeliveryMode,
  values: Partial<Record<CheckoutRequiredField, string | null | undefined>>,
): CheckoutRequiredField[] {
  return CHECKOUT_REQUIRED_FIELDS[mode].filter((field) => !values[field]?.trim());
}

export interface CheckoutAddressFields {
  shippingAddress: string | null;
  city: string | null;
  zone: string | null;
  area: string | null;
  cityName: string | null;
  zoneName: string | null;
  areaName: string | null;
}

const NO_ADDRESS: CheckoutAddressFields = {
  shippingAddress: null,
  city: null,
  zone: null,
  area: null,
  cityName: null,
  zoneName: null,
  areaName: null,
};

/**
 * The address the order carries: the buyer's for delivery, nothing for
 * pickup and service orders (a typed address is dropped, not sent).
 */
export function checkoutAddressForMode(
  mode: CheckoutDeliveryMode,
  values: Partial<Record<keyof CheckoutAddressFields, unknown>>,
): CheckoutAddressFields {
  if (mode !== "delivery") return { ...NO_ADDRESS };
  const text = (value: unknown) => {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  };
  return {
    shippingAddress: text(values.shippingAddress),
    city: text(values.city),
    zone: text(values.zone),
    area: text(values.area),
    cityName: text(values.cityName),
    zoneName: text(values.zoneName),
    areaName: text(values.areaName),
  };
}

/** The cash payment's name for the path: "Cash on delivery", "Pay at pickup", "Pay on service". */
export function cashOnDeliveryLabel(
  mode: CheckoutDeliveryMode,
  copy: {
    cashOnDeliveryText: string;
    orderReceiptPaymentMethodPayAtPickupText: string;
    orderReceiptPaymentMethodPayOnServiceText: string;
  },
): string {
  if (mode === "pickup") return copy.orderReceiptPaymentMethodPayAtPickupText;
  if (mode === "none") return copy.orderReceiptPaymentMethodPayOnServiceText;
  return copy.cashOnDeliveryText;
}

/** Cash-on-delivery wording for the path: at the door, at the counter, or at the service. */
export function cashOnDeliveryDescription(
  mode: CheckoutDeliveryMode,
  copy: { payOnDeliveryText: string; payAtPickupText: string; payAtServiceText: string },
): string {
  if (mode === "pickup") return copy.payAtPickupText;
  if (mode === "none") return copy.payAtServiceText;
  return copy.payOnDeliveryText;
}

// ── The cart page's form (browser only) ────────────────────────────────────

/** The path the cart page shows now. */
export function readCheckoutDeliveryMode(root: ParentNode = document): CheckoutDeliveryMode {
  const page = root.querySelector<HTMLElement>("#cartPageRoot");
  if (page?.dataset.deliveryNeed === "none") return "none";
  const chosen = root.querySelector<HTMLInputElement>('[name="deliveryMode"]:checked')?.value
    ?? root.querySelector<HTMLInputElement>('input[type="hidden"][name="deliveryMode"]')?.value;
  return chosen === "pickup" ? "pickup" : "delivery";
}

/**
 * Shows the path on the page: the address fields are hidden and left out of
 * the form (a disabled fieldset submits nothing) unless delivering.
 */
export function applyCheckoutDeliveryMode(root: ParentNode = document): CheckoutDeliveryMode {
  const mode = readCheckoutDeliveryMode(root);
  const page = root.querySelector<HTMLElement>("#cartPageRoot");
  if (page && page.dataset.deliveryMode !== mode) page.dataset.deliveryMode = mode;
  const address = root.querySelector<HTMLFieldSetElement>("fieldset[data-address-fields]");
  if (address) address.disabled = mode !== "delivery";
  return mode;
}
