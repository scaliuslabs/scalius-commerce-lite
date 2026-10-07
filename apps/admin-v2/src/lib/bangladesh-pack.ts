/** The Bangladesh pack (plugins/bangladesh): SSLCommerz, its couriers, SMS gateways, fraud checkers and places. */
export const BANGLADESH_PACK_ID = "scalius.bangladesh";

/**
 * Built-in payment gateways an app replaced (`sslcommerz`: the pack's). Orders
 * paid before the move keep the old id; it means the app's provider now, and
 * until the app is active it can't be used ("Activate Bangladesh pack in Apps").
 */
export { RETIRED_PAYMENT_METHODS, retiredPaymentMethod } from "@scalius/shared/plugins/providers/retired-payments";
