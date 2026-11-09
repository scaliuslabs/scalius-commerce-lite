// What an order's `payment_method` means: the one vocabulary every surface
// that names or groups orders by how they are paid reads (the dashboard's
// labels and filters, analytics, exports, the timeline, the storefront).
// Browser-safe. Every label map over these methods is typed
// `Record<BuiltInOrderPaymentMethod, …>` and tested against this list, so a
// new method cannot ship without a name and a kind on each surface.
import { isQualifiedProviderId } from "./plugins/providers/kinds";

/**
 * The methods the platform itself writes to `orders.payment_method`; an
 * app's gateway is `<plugin id>:<provider id>`.
 *
 * - `cod`: cash on delivery (or at pickup, or on service);
 * - `net_terms`: the store's invoice, paid later by its due date;
 * - `manual`: paid as it was placed, to the store (staff's Mark as paid, an
 *   in-person sale), recorded by its way of payment;
 * - `gift_card`: paid entirely by gift cards at checkout;
 * - `stripe`: the built-in card gateway.
 */
export const BUILT_IN_ORDER_PAYMENT_METHODS = ["cod", "net_terms", "manual", "gift_card", "stripe"] as const;
export type BuiltInOrderPaymentMethod = (typeof BUILT_IN_ORDER_PAYMENT_METHODS)[number];

/**
 * How an order's money reaches the store:
 * - `cash_on_delivery`: collected at the door, the counter of a pickup, or the service;
 * - `invoice`: owed, paid later by its due date;
 * - `paid_to_store`: received by the store directly, in person or by transfer (never online);
 * - `gift_card`: gift cards the store sold earlier;
 * - `online`: a payment gateway (built-in or an app's).
 */
export const ORDER_PAYMENT_KINDS = ["cash_on_delivery", "invoice", "paid_to_store", "gift_card", "online"] as const;
export type OrderPaymentKind = (typeof ORDER_PAYMENT_KINDS)[number];

const KIND: Record<BuiltInOrderPaymentMethod, OrderPaymentKind> = {
  cod: "cash_on_delivery",
  net_terms: "invoice",
  manual: "paid_to_store",
  gift_card: "gift_card",
  stripe: "online",
};

/**
 * The English names exports and server-written text use (the dashboard and
 * storefront translate their own from their catalogues).
 */
export const ORDER_PAYMENT_METHOD_LABELS_EN: Record<BuiltInOrderPaymentMethod, string> = {
  cod: "Cash on delivery",
  net_terms: "Invoice",
  manual: "Recorded payment",
  gift_card: "Gift card",
  stripe: "Card (Stripe)",
};

/** SSLCommerz before it moved to the Bangladesh pack: still an online gateway on old orders. */
const LEGACY_ONLINE_METHODS = new Set(["sslcommerz"]);

export function isBuiltInOrderPaymentMethod(value: unknown): value is BuiltInOrderPaymentMethod {
  return typeof value === "string" && Object.hasOwn(KIND, value);
}

/**
 * The kind of an order's payment method; null for a value no surface should
 * guess about. An app's deferred method (`flow: "deferred"`) reads `online`
 * here: its order says it is owed by its `paymentTerms`.
 */
export function orderPaymentKind(method: string | null | undefined): OrderPaymentKind | null {
  if (isBuiltInOrderPaymentMethod(method)) return KIND[method];
  if (typeof method === "string" && (isQualifiedProviderId(method) || LEGACY_ONLINE_METHODS.has(method))) return "online";
  return null;
}
