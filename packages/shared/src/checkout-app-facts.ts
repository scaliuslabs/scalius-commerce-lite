// Checkout app facts (plugin platform, checkout functions): what an app's
// discount took and the delivery options apps reshape. Pure types shared by
// the checkout (which computes them) and orders (which persist and show
// them), so neither core domain depends on the other for them.

import type { AppLineInputs } from "./line-properties";

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
 * A write an app's `checkout.discounts` or `cart.validate` answer commits
 * with the order: a record its function read, at the revision the function
 * saw (null: it did not exist). The order and the write commit in one batch
 * or not at all, so a balance a discount spends is spent once and a slot a
 * hold takes is taken once. Built by the platform from a validated answer
 * (size and index columns checked), never taken from the app as is.
 */
export interface AppObjectCommit {
  pluginId: string;
  /** The answer it came from: a discount's write (only with an applied discount) or a hold (always with the order). */
  point: "checkout.discounts" | "cart.validate";
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
  /** The fee the order shows: the charge, or the fees a free-over amount waived. */
  baseAmountMinor: number;
  /** Every priced profile's free-over amount waived its fee: it stays free whatever an app prices. */
  waived: boolean;
  /**
   * Each priced shipping profile's share (a free profile's lines price
   * nothing and have none). An app's price for a profile replaces that
   * share's fee; the share's free-over waiver still applies after it.
   */
  shares?: Array<{ profileId: string; baseMinor: number; waived: boolean }>;
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
  /** The serialized buyer inputs (`order_items.properties`), or null; a purchase option rides there as `_purchase_option`. */
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
  /** Who places it: staff (`admin`, the default), an app (`app`), or a point of sale (`pos`). */
  channel?: "admin" | "app" | "pos";
  /** The sales channel the order sells from (resolved by the create; absent: the online store). */
  salesChannelId?: string | null;
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
  /**
   * The country of the market that prices and places the order: the shipping country, the billing
   * country when nothing physical ships, null for a pickup (the backup market). Required: apps see
   * this market, never one derived from the destination alone.
   */
  marketCountry: string | null;
  address: { city: string; zone: string; area: string | null } | null;
  /** Another country's admin area and postal code: shipping zones match on them. */
  shippingAdminArea?: string | null;
  shippingPostalCode?: string | null;
  locationNames: { cityName: string | null; zoneName: string | null };
  /**
   * The apps' checkout answers staff gave (`<app id>.<key>`, validated against
   * their declarations): the apps' functions see them, as at checkout.
   */
  attributes?: Readonly<Record<string, string>>;
  /**
   * How the order is paid: cash on delivery (the default), an invoice
   * (`net_terms`), or already paid as it is placed (`manual`: marked paid,
   * an in-person sale).
   */
  paymentMethod?: "cod" | "net_terms" | "manual";
}

export interface ManualOrderAppOutcome {
  /** The delivery charge after the apps (an app may have priced the method). */
  shippingMinor: number;
  /** The chosen method as the order keeps it (an app may have renamed or priced it). */
  deliveryMethod: ManualOrderAppDeliveryMethod | null;
  appDiscounts: AppliedAppDiscount[];
  /** The staff discount plus the apps', for the tax quote; undefined without app discounts. */
  discountAllocation: { lines: Array<{ lineId: string; amountMinor: number }>; shippingMinor: number } | undefined;
  /**
   * The apps' record writes the order commits, as at checkout: every
   * `cart.validate` hold (a delivery slot's place) and the writes of applied
   * discounts, each at the revision its app read. Absent without any.
   */
  appObjectCommits?: AppObjectCommit[];
}

/**
 * The apps' checkout functions on a staff order, bound to the request's
 * database and apps. `price` applies their rules, delivery options, payment
 * method and discounts (it throws the checkout refusals).
 */
export interface ManualOrderAppFunctions {
  price(input: ManualOrderAppInput): Promise<ManualOrderAppOutcome>;
  /** The order batch's guarded writes of `appObjectCommits` (a hold another order took fails the batch). */
  commitStatements?(commits: readonly AppObjectCommit[]): readonly unknown[];
  /** The staff's refusal when a failed batch lost a hold's race (`app_offer_changed`), else null. */
  commitConflict?(error: unknown): Promise<Error | null>;
  /** The purchase options the active apps offer, `<app id>.<key>` → title: what a line's `purchaseOptions` may name. */
  readonly purchaseOptions?: ReadonlyMap<string, string>;
  /** The active apps' line inputs: what a line's properties may carry beside the product's own. */
  readonly lineInputs?: readonly AppLineInputs[];
}
