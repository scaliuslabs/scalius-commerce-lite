// Checkout app facts (plugin platform, checkout functions): what an app's
// discount took and the delivery options apps reshape. Pure types shared by
// the checkout (which computes them) and orders (which persist and show
// them), so neither core domain depends on the other for them.


export type AppDiscountTarget = "order" | "lines" | "shipping";

/** One app discount as it applied; amounts are what it actually took. */
export interface AppliedAppDiscount {
  pluginId: string;
  appName: string;
  title: string;
  /** The code it answered to (normalized), when code-driven. */
  code: string | null;
  target: AppDiscountTarget;
  /** Off the items. */
  amountMinor: number;
  /** Off delivery. */
  shippingAmountMinor: number;
  /** Per line (tax allocation line id); empty for a shipping discount. */
  lines: Array<{ lineId: string; amountMinor: number }>;
}

/**
 * A write an app's `checkout.discounts` answer commits with the order: its
 * snapshot record (the buyer's, id = customer id) at the revision the
 * function saw (null: it did not exist). The order and the write commit in
 * one batch or not at all, so a balance the discount spends is spent once.
 * Built by the platform from a validated answer (size and index columns
 * checked), never taken from the app as is.
 */
export interface AppObjectCommit {
  pluginId: string;
  object: string;
  public: boolean;
  events: boolean;
  id: string;
  expectedRevision: number | null;
  /** The record as JSON, at most the storage record size. */
  dataJson: string;
  /** The record's index columns under the collection's declaration. */
  columns: Record<string, string | null>;
}

export interface CheckoutRateOption {
  rateId: string;
  name: string;
  kind: "delivery" | "pickup";
  /** What the buyer pays for this option. */
  amountMinor: number;
  /** The rate's own charge before the platform's free-delivery rules. */
  baseAmountMinor: number;
  /** A platform free-delivery rule (a free-delivery product, a free-over threshold) applies: it stays free. */
  waived: boolean;
}

// ── Staff-created (manual) orders, channel "admin" ───────────────────────
//
// The apps' checkout functions on a manual order. The checkout module
// implements `ManualOrderAppFunctions` (it owns the merge rules); the API
// builds one per request and hands it to the orders module's quote and
// create, so orders never depends on checkout.

/** One priced line of a manual order as apps see it, by its tax allocation line id. */
export interface ManualOrderAppLine {
  lineId: string;
  productId: string;
  variantId: string;
  productName: string;
  variantLabel: string | null;
  quantity: number;
  unitPriceMinor: number;
  isGiftCard: boolean;
  /** The serialized buyer inputs (`order_items.properties`), or null. */
  properties: string | null;
}

export interface ManualOrderAppDeliveryMethod {
  id: string;
  name: string;
  /** The method's own fee (`shipping_methods.fee_minor`). */
  feeMinor: number;
  kind: "delivery" | "pickup";
}

export interface ManualOrderAppInput {
  /** The order's currency at the store's price increment (app amounts round to it). */
  currency: { code: string; decimalPlaces: number; priceIncrementMinor: number };
  lines: readonly ManualOrderAppLine[];
  /** The staff discount, already checked against the discountable subtotal. */
  manualDiscountMinor: number;
  /** The staff delivery charge. */
  shippingMinor: number;
  /** The chosen method; null for a custom charge or nothing physical. */
  deliveryMethod: ManualOrderAppDeliveryMethod | null;
  requiresShipping: boolean;
  /** The shipping country (null when nothing ships); Bangladesh's City/Thana ids and names below. */
  shippingCountryCode?: string | null;
  address: { city: string; zone: string; area: string | null } | null;
  /** Another country's admin area and postal code: shipping zones match on them. */
  shippingAdminArea?: string | null;
  shippingPostalCode?: string | null;
  locationNames: { cityName: string | null; zoneName: string | null };
  /** How the order is paid: cash on delivery (the default) or an invoice (`net_terms`). */
  paymentMethod?: "cod" | "net_terms";
}

export interface ManualOrderAppOutcome {
  /** The delivery charge after the apps (an app may have priced the method). */
  shippingMinor: number;
  /** The chosen method as the order keeps it (an app may have renamed or priced it). */
  deliveryMethod: ManualOrderAppDeliveryMethod | null;
  appDiscounts: AppliedAppDiscount[];
  /** The staff discount plus the apps', for the tax quote; undefined without app discounts. */
  discountAllocation: { lines: Array<{ lineId: string; amountMinor: number }>; shippingMinor: number } | undefined;
}

/**
 * The apps' checkout functions on a staff order, bound to the request's
 * database and apps. `price` applies their rules, delivery options, payment
 * method and discounts (it throws the checkout refusals).
 */
export interface ManualOrderAppFunctions {
  price(input: ManualOrderAppInput): Promise<ManualOrderAppOutcome>;
}
