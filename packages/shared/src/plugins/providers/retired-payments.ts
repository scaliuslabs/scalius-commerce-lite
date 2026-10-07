// Built-in payment gateways an app provider replaced, by their old id. Orders
// and payments made before the move keep the old id; every surface reads it
// as the app provider that replaced it (core: the payment registry; the
// dashboard and the storefront: names and marks). Data only, browser-safe.

/** The Bangladesh pack: SSLCommerz moved into it. */
const BANGLADESH_PACK_ID = "scalius.bangladesh";

export interface RetiredPaymentMethod {
  /** Merchant-facing provider name. */
  name: string;
  /** The app provider that serves the id now: `<plugin id>:<provider id>`. */
  replacement: string;
}

export const RETIRED_PAYMENT_METHODS: Readonly<Record<string, RetiredPaymentMethod>> = {
  sslcommerz: { name: "SSLCommerz", replacement: `${BANGLADESH_PACK_ID}:sslcommerz` },
};

/** The retired payment method an id names, or null. */
export function retiredPaymentMethod(id: unknown): RetiredPaymentMethod | null {
  return typeof id === "string" && Object.hasOwn(RETIRED_PAYMENT_METHODS, id) ? RETIRED_PAYMENT_METHODS[id]! : null;
}

/** The app provider id a stored payment method means now: a retired id's replacement, else the id itself. */
export function currentPaymentMethodId(id: string): string {
  return retiredPaymentMethod(id)?.replacement ?? id;
}
