/**
 * Order-line fulfilment vocabulary and the one line-type resolution rule
 * (Wave A §2.1, §2.7). Pure: the storefront, the API and the dashboard all
 * resolve a cart the same way, and the database CHECKs use the same values.
 *
 * - A *fulfilment kind* is what the merchant sells (`product_variants.fulfillment_kind`).
 *   Gift cards are a product flag (`products.is_gift_card`), not a kind.
 * - A *fulfilment type* is how one order line reaches the buyer
 *   (`order_items.fulfillment_type`), frozen when the order is committed.
 */

export const FULFILLMENT_KINDS = ["physical", "digital", "service"] as const;
export type FulfillmentKind = (typeof FULFILLMENT_KINDS)[number];

export const FULFILLMENT_TYPES = ["ship", "pickup", "digital", "gift_card", "service"] as const;
export type FulfillmentType = (typeof FULFILLMENT_TYPES)[number];

/** `shipping_methods.kind`, snapshotted as `orders.shipping_method_kind`. */
export const DELIVERY_METHOD_KINDS = ["delivery", "pickup"] as const;
export type DeliveryMethodKind = (typeof DELIVERY_METHOD_KINDS)[number];

/** `order_fulfillments.status`: a fulfilment is only ever voided, never edited. */
export const FULFILLMENT_RECORD_STATUSES = ["active", "voided"] as const;
export type FulfillmentRecordStatus = (typeof FULFILLMENT_RECORD_STATUSES)[number];

/** Types staff fulfil by a real action (send, hand over at the counter, perform). */
export const MANUAL_FULFILLMENT_TYPES = ["ship", "pickup", "service"] as const satisfies readonly FulfillmentType[];
/** Types the system fulfils once payment settles (Wave B fulfillers). */
export const AUTO_FULFILLMENT_TYPES = ["digital", "gift_card"] as const satisfies readonly FulfillmentType[];
/** Types whose units physically reach the buyer and can come back as a return. */
export const RETURNABLE_FULFILLMENT_TYPES = ["ship", "pickup"] as const satisfies readonly FulfillmentType[];

export function isFulfillmentKind(value: unknown): value is FulfillmentKind {
  return typeof value === "string" && (FULFILLMENT_KINDS as readonly string[]).includes(value);
}

export function isFulfillmentType(value: unknown): value is FulfillmentType {
  return typeof value === "string" && (FULFILLMENT_TYPES as readonly string[]).includes(value);
}

export function isDeliveryMethodKind(value: unknown): value is DeliveryMethodKind {
  return typeof value === "string" && (DELIVERY_METHOD_KINDS as readonly string[]).includes(value);
}

export function isAutoFulfillmentType(type: FulfillmentType): boolean {
  return (AUTO_FULFILLMENT_TYPES as readonly FulfillmentType[]).includes(type);
}

export function isReturnableFulfillmentType(type: FulfillmentType): boolean {
  return (RETURNABLE_FULFILLMENT_TYPES as readonly FulfillmentType[]).includes(type);
}

/**
 * Whether an unfulfilled line of this type keeps the order from `delivered`.
 * Digital and gift-card lines fulfil themselves after settlement and never block.
 */
export function blocksDelivered(type: FulfillmentType): boolean {
  return !isAutoFulfillmentType(type);
}

/**
 * The one rule for "may this order be paid in cash?" (on delivery, at the
 * pickup counter, at the service): only when every line is handed over in
 * person. A download or a gift card is sent once the order is paid, so one
 * such line refuses cash for the whole order (an e-book beside a vase is paid
 * online). A physical line still without a delivery method (null) is handed
 * over in person whichever method is chosen. An empty cart never.
 */
export function allowsCashOnDelivery(lineTypes: readonly (FulfillmentType | null)[]): boolean {
  return lineTypes.length > 0 && lineTypes.every((type) => type === null || !isAutoFulfillmentType(type));
}

/**
 * Whether a payment method may pay for an order, by how its money reaches
 * the store (its kind, never its id): cash collected where goods change hands
 * (`cash_on_delivery`: the built-in method, or an app's deferred method that
 * declares it) only where cash fits every line (`allowsCashOnDelivery`); every
 * other kind (online, an invoice, a payment to the store, a gift card) pays
 * for anything. What is sent once paid (a key, a download, a gift card) waits
 * for that payment: automatic fulfilment hands it over only on a settled
 * payment, an invoice's included. The one answer for checkout, the cart
 * check, the staff quote and the storefront (`cashPayable` is its SKU side).
 */
export function paymentMethodFits(kind: string | null | undefined, cashFits: boolean): boolean {
  return kind !== "cash_on_delivery" || cashFits;
}

/**
 * Whether cash may pay for a SKU: not for a download, a key or a gift card,
 * which is sent once the order is paid, so no cash promise collected at a
 * door it never reaches buys it (`allowsCashOnDelivery`); every other way to
 * pay does (`paymentMethodFits`), the invoice and a gift card included. A kit
 * is cash payable only when every one of its items is.
 */
export function cashPayable(source: { fulfillmentKind: string | null | undefined; isGiftCard?: boolean | null }): boolean {
  return source.isGiftCard !== true && source.fulfillmentKind !== "digital";
}

/**
 * What a kit sells, from its items (a kit has no fulfilment of its own): it
 * ships when any item ships, else it is digital when any item is, else a
 * service. It is cash payable only when every item is (`cashPayable`).
 */
export function kitFulfillmentKind(itemKinds: readonly (string | null | undefined)[]): FulfillmentKind {
  if (itemKinds.length === 0 || itemKinds.some((kind) => kind !== "digital" && kind !== "service")) return "physical";
  return itemKinds.includes("digital") ? "digital" : "service";
}

/**
 * The one type a buyer's line shows when it is sold as several lines (a kit,
 * an app's bundle): one sent after payment (a gift card, a download) refuses
 * cash for all of it, so it wins; then a physical line (null while it has
 * no delivery method), then a service.
 */
export function strictestFulfillmentType(types: readonly (FulfillmentType | null)[]): FulfillmentType | null {
  if (types.includes("gift_card")) return "gift_card";
  if (types.includes("digital")) return "digital";
  if (types.length === 0 || types.includes(null)) return null;
  for (const type of ["ship", "pickup"] as const) if (types.includes(type)) return type;
  return "service";
}

/** What a sellable line is, as read with its product and variant. */
export interface FulfilmentLineSource {
  fulfillmentKind: FulfillmentKind;
  isGiftCard: boolean;
}

/**
 * The fulfilment type of one line. Physical lines take the order's single
 * delivery method; they have no type (null) until one is chosen.
 */
export function resolveLineFulfillmentType(
  line: FulfilmentLineSource,
  deliveryMethodKind: DeliveryMethodKind | null,
): FulfillmentType | null {
  if (line.isGiftCard) return "gift_card";
  if (line.fulfillmentKind === "digital") return "digital";
  if (line.fulfillmentKind === "service") return "service";
  if (deliveryMethodKind === "delivery") return "ship";
  if (deliveryMethodKind === "pickup") return "pickup";
  return null;
}

export type CheckoutFulfilmentIssue =
  /** The cart has no lines. */
  | "EMPTY"
  /** A physical line needs a delivery or pickup method. */
  | "delivery_method_required";

export interface CheckoutFulfilmentPlan {
  /** One type per input line, in input order. */
  lineTypes: FulfillmentType[];
  /** Some line is physical, so the order needs exactly one delivery method. */
  requiresDeliveryMethod: boolean;
  /**
   * The method the order actually uses: the chosen one when the cart has a
   * physical line, otherwise null (no method, no shipping fee is stored).
   */
  deliveryMethodKind: DeliveryMethodKind | null;
  /** `orders.requires_shipping`: some line is `ship`. */
  requiresShipping: boolean;
  /** Address, city and zone are collected and stored only when shipping. */
  requiresAddress: boolean;
  /** Without an address the tax destination is null: only store-wide rates apply. */
  usesAddressTaxDestination: boolean;
  /** Cash on delivery / at the counter / at the service (`allowsCashOnDelivery`): every line is handed over in person. */
  allowsCashOnDelivery: boolean;
}

export type CheckoutFulfilmentResult =
  | ({ ok: true } & CheckoutFulfilmentPlan)
  | { ok: false; issue: CheckoutFulfilmentIssue };

/**
 * Resolve a whole cart (§2.7). One order never mixes `ship` and `pickup`:
 * every physical line takes the one chosen method. A method chosen for a
 * cart without physical lines is not used.
 */
export function resolveCheckoutFulfilment(
  lines: readonly FulfilmentLineSource[],
  chosenDeliveryMethodKind: DeliveryMethodKind | null,
): CheckoutFulfilmentResult {
  if (lines.length === 0) return { ok: false, issue: "EMPTY" };
  const requiresDeliveryMethod = lines.some((line) =>
    !line.isGiftCard && line.fulfillmentKind === "physical");
  if (requiresDeliveryMethod && chosenDeliveryMethodKind === null) {
    return { ok: false, issue: "delivery_method_required" };
  }
  const deliveryMethodKind = requiresDeliveryMethod ? chosenDeliveryMethodKind : null;
  const lineTypes = lines.map((line) => resolveLineFulfillmentType(line, deliveryMethodKind)!);
  const requiresShipping = lineTypes.includes("ship");
  return {
    ok: true,
    lineTypes,
    requiresDeliveryMethod,
    deliveryMethodKind,
    requiresShipping,
    requiresAddress: requiresShipping,
    usesAddressTaxDestination: requiresShipping,
    allowsCashOnDelivery: allowsCashOnDelivery(lineTypes),
  };
}
