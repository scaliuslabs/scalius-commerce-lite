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
