// What a stored payment method id means, whatever is installed today. A leaf:
// settings, checkout and order code classify ids without loading adapters.

import { isQualifiedProviderId } from "@scalius/shared/plugins/providers/kinds";
import type { ProviderCountries } from "@scalius/shared/plugins/providers/common";
import { sql, type AnyColumn, type SQL } from "drizzle-orm";
import { RETIRED_PAYMENT_PROVIDERS } from "../../../integrations/retired-providers";

/** The built-in gateways (registry.ts holds their adapters, in this order). */
export const BUILT_IN_PAYMENT_GATEWAY_IDS = ["stripe"] as const;

/**
 * Built-in gateway ids an app provider replaced (`sslcommerz`: the Bangladesh
 * pack's). Orders and payments made before the move keep them; the registry
 * resolves each to its app provider (retired-providers.ts).
 */
export const RETIRED_PAYMENT_GATEWAY_IDS: readonly string[] = Object.keys(RETIRED_PAYMENT_PROVIDERS);

/** Whether an id is a retired built-in gateway an app provider now serves. */
export function isRetiredPaymentMethod(id: unknown): id is string {
  return typeof id === "string" && RETIRED_PAYMENT_GATEWAY_IDS.includes(id);
}

/**
 * The stored ids that mean the same gateway: an app provider's id and the
 * retired built-in id it replaced (`scalius.bangladesh:sslcommerz` and
 * `sslcommerz`), so a filter by either finds orders from before and after
 * the move. Any other id is only itself.
 */
export function paymentMethodAliases(id: string): string[] {
  const retired = RETIRED_PAYMENT_PROVIDERS[id];
  if (retired && Object.hasOwn(RETIRED_PAYMENT_PROVIDERS, id)) return [id, retired.replacement];
  const replaced = Object.entries(RETIRED_PAYMENT_PROVIDERS).filter(([, entry]) => entry.replacement === id).map(([old]) => old);
  return [id, ...replaced];
}

/**
 * Whether a gateway id needs the request's app providers to resolve: an app
 * provider's id, or a retired built-in id one of them replaced.
 */
export function isAppPaymentMethod(id: unknown): id is string {
  return isQualifiedProviderId(id) || isRetiredPaymentMethod(id);
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
  return id === COD_PAYMENT_METHOD || isOnlinePaymentMethod(id);
}

/** SQL twin of `isOnlinePaymentMethod` for a stored column (built-in and retired ids never contain a colon). */
export function onlinePaymentMethodCondition(column: AnyColumn | SQL): SQL {
  const builtIns = sql.join([...BUILT_IN_PAYMENT_GATEWAY_IDS, ...RETIRED_PAYMENT_GATEWAY_IDS].map((id) => sql`${id}`), sql`, `);
  return sql`(${column} IN (${builtIns}) OR instr(${column}, ':') > 0)`;
}
