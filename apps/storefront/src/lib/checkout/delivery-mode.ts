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
 * Phone is required on every path unless the shared contact rule lets a
 * `none` cart go without one (lib/checkout/contact-need.ts). The form's mode
 * is only what the buyer chose: the API decides from the SKUs and the rate's
 * kind, and ignores an address sent for a pickup or service order. The same
 * tables drive the browser field checks and the no-JS form path
 * (`lib/cart/server.ts`).
 */
import type { DeliveryMethodKind } from "@scalius/shared/fulfilment";
import { isLocationCountry, readForeignAddressFields, shippingCountryOf } from "./shipping-country";

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

/** City and thana are Bangladesh's (its delivery locations); another country's fields follow its rules. */
const LOCATION_FIELDS: ReadonlySet<CheckoutRequiredField> = new Set(["city", "zone"]);

export function isCheckoutFieldRequired(
  mode: CheckoutDeliveryMode,
  field: CheckoutRequiredField,
  countryCode?: string | null,
): boolean {
  if (LOCATION_FIELDS.has(field) && !isLocationCountry(countryCode)) return false;
  return CHECKOUT_REQUIRED_FIELDS[mode].includes(field);
}

/** The required fields left empty, in form order (City and Thana only for Bangladesh). */
export function missingCheckoutFields(
  mode: CheckoutDeliveryMode,
  values: Partial<Record<CheckoutRequiredField, string | null | undefined>>,
  countryCode?: string | null,
): CheckoutRequiredField[] {
  return CHECKOUT_REQUIRED_FIELDS[mode].filter((field) =>
    isCheckoutFieldRequired(mode, field, countryCode) && !values[field]?.trim());
}

export interface CheckoutAddressFields {
  /** Another country's address only: a Bangladesh address sends none (as before). */
  shippingCountryCode?: string;
  shippingAddressLine2?: string | null;
  shippingDependentLocality?: string | null;
  shippingLocality?: string | null;
  shippingAdminArea?: string | null;
  shippingPostalCode?: string | null;
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
 * pickup and service orders (a typed address is dropped, not sent). A
 * Bangladesh address sends its line and City/Thana/Area as before; another
 * country's sends its country and canonical fields, never Bangladesh's ids.
 */
export function checkoutAddressForMode(
  mode: CheckoutDeliveryMode,
  values: Partial<Record<keyof CheckoutAddressFields, unknown>>,
): CheckoutAddressFields {
  // Nothing ships (pickup, or nothing physical): no address. An order with
  // nothing physical is placed in its billing country (billing-address.ts).
  if (mode !== "delivery") return { ...NO_ADDRESS };
  const text = (value: unknown) => {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  };
  if (!isLocationCountry(typeof values.shippingCountryCode === "string" ? values.shippingCountryCode : null)) {
    return {
      ...NO_ADDRESS,
      shippingCountryCode: shippingCountryOf(values.shippingCountryCode),
      shippingAddress: text(values.shippingAddress),
      ...readForeignAddressFields((field) => values[field]),
    };
  }
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

/** The path and address fields a checkout transfer (the cart page → payment step) carries. */
export const CHECKOUT_PATH_FIELDS = [
  "deliveryMode",
  "shippingCountryCode",
  "shippingAddress",
  "shippingAddressLine2",
  "shippingDependentLocality",
  "shippingLocality",
  "shippingAdminArea",
  "shippingPostalCode",
  "city",
  "zone",
  "area",
  "cityName",
  "zoneName",
  "areaName",
] as const;
export type CheckoutPathField = (typeof CHECKOUT_PATH_FIELDS)[number];

/**
 * Every path field of a checkout transfer for the path the page shows: the
 * path itself and the address it sends (`checkoutAddressForMode`), null for a
 * field the path does not send. The cart page writes the transfer with it
 * and keeps an existing transfer in step with it, so a form value the path
 * does not use (a hidden Delivery radio, a saved draft's city) never reaches
 * the payment step.
 */
export function checkoutTransferPath(
  mode: CheckoutDeliveryMode,
  values: Partial<Record<keyof CheckoutAddressFields, unknown>>,
): Record<CheckoutPathField, string | null> {
  const path = Object.fromEntries(CHECKOUT_PATH_FIELDS.map((field) => [field, null])) as Record<CheckoutPathField, string | null>;
  path.deliveryMode = mode;
  for (const [field, value] of Object.entries(checkoutAddressForMode(mode, values))) {
    if (field in path && typeof value === "string") path[field as CheckoutPathField] = value;
  }
  return path;
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
