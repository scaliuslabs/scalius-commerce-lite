// What a stored payment method id means, whatever is installed today. A leaf:
// settings, checkout and order code classify ids without loading adapters.

import { isQualifiedProviderId } from "@scalius/shared/plugins/providers/kinds";
import type { ProviderCountries } from "@scalius/shared/plugins/providers/common";
import { sql, type AnyColumn, type SQL } from "drizzle-orm";
import { NET_TERMS_LABEL, NET_TERMS_PAYMENT_METHOD, RECORDED_PAYMENT_METHOD } from "@scalius/shared/payment-terms";

/** The built-in gateways (registry.ts holds their adapters, in this order). */
export const BUILT_IN_PAYMENT_GATEWAY_IDS = ["stripe"] as const;

/** Whether a gateway id needs the request's app providers to resolve: an app provider's id. */
export function isAppPaymentMethod(id: unknown): id is string {
  return isQualifiedProviderId(id);
}

export const COD_PAYMENT_METHOD = "cod";
export const COD_LABEL = "Cash on Delivery";

/**
 * The shipping countries cash on delivery serves (MARKETS-DESIGN step 3b):
 * riders collect it through Bangladesh's couriers, in BDT whole taka (its
 * amount codec), so it is offered for deliveries to Bangladesh only. Pickup
 * and orders that ship nothing have no shipping country: the counter or the
 * service collects the cash.
 */
export const COD_COUNTRIES: ProviderCountries = ["BD"];

/**
 * The built-in deferred method (`@scalius/shared/payment-terms`): an invoice
 * paid later by its due date. Not a gateway: the order commits unpaid with
 * its terms, and its payments are recorded later (or arrive from a gateway
 * the buyer pays the balance with).
 */
export { NET_TERMS_LABEL, NET_TERMS_PAYMENT_METHOD, RECORDED_PAYMENT_METHOD };

/**
 * Payment rows settled outside any provider: cash on delivery and a payment
 * staff or an app recorded (a bank transfer against an invoice). Their
 * refunds are confirmed manual settlements, never provider calls.
 */
export function isManualSettlementMethod(id: unknown): boolean {
  return id === COD_PAYMENT_METHOD || id === RECORDED_PAYMENT_METHOD;
}

/**
 * A gift-card tender (`orders.payment_method` of an order the buyer's gift
 * cards cover, and the `order_payments` rows they paid). Not a gateway and
 * not a checkout setting: the gift-cards domain records it with no provider.
 */
export const GIFT_CARD_TENDER_METHOD = "gift_card";
export const GIFT_CARD_TENDER_LABEL = "Gift card";

/**
 * Whether an id names an online gateway: a built-in one or an app provider
 * (`<plugin id>:<provider id>`). Stored orders, attempts and payments keep
 * this meaning after the app is deactivated or removed, so recovery,
 * reconciliation and refunds still treat them as online (and fail closed
 * when the gateway cannot be reached).
 */
export function isOnlinePaymentMethod(id: unknown): id is string {
  return typeof id === "string"
    && ((BUILT_IN_PAYMENT_GATEWAY_IDS as readonly string[]).includes(id) || isAppPaymentMethod(id));
}

export function isPaymentMethodId(id: unknown): id is string {
  return id === COD_PAYMENT_METHOD || id === NET_TERMS_PAYMENT_METHOD || isOnlinePaymentMethod(id);
}

/** SQL twin of `isOnlinePaymentMethod` for a stored column (built-in ids never contain a colon). */
export function onlinePaymentMethodCondition(column: AnyColumn | SQL): SQL {
  const builtIns = sql.join(BUILT_IN_PAYMENT_GATEWAY_IDS.map((id) => sql`${id}`), sql`, `);
  return sql`(${column} IN (${builtIns}) OR instr(${column}, ':') > 0)`;
}
