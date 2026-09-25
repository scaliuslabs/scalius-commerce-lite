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
  | "DELIVERY_METHOD_REQUIRED";

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
  /**
   * Cash on delivery / at the counter / at the service. Never for carts made
   * only of digital or gift-card lines.
   */
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
    return { ok: false, issue: "DELIVERY_METHOD_REQUIRED" };
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
    allowsCashOnDelivery: lineTypes.some((type) => !isAutoFulfillmentType(type)),
  };
}
