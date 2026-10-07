// Payment methods that come from apps: orders, payments, attempts and refunds
// store them as `<plugin id>:<provider id>` (`scalius.bkash:bkash`). The
// dashboard names them by the provider's name when it can read the installed
// apps, and otherwise by the provider id in words, never by the stored id. A
// retired built-in id (`sslcommerz`, now the Bangladesh pack's) reads as the
// provider that replaced it.

import { parseQualifiedProviderId } from "@scalius/shared/plugins/providers/kinds";
import { RETIRED_PAYMENT_METHODS, retiredPaymentMethod } from "./bangladesh-pack";

/** "Bkash" for `scalius.bkash:bkash`, "SSLCommerz" for `sslcommerz` and its replacement; null for cash, built-in gateways or anything malformed. */
export function appPaymentMethodFallbackName(id: string): string | null {
  const retired = retiredPaymentMethod(id) ?? Object.values(RETIRED_PAYMENT_METHODS).find((entry) => entry.replacement === id);
  if (retired) return retired.name;
  const app = parseQualifiedProviderId(id);
  if (!app) return null;
  const words = app.providerId.replace(/-/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** An app method's name from the installed apps' providers, else its fallback; null for other methods. */
export function appPaymentMethodName(id: string, appNames?: ReadonlyMap<string, string>): string | null {
  const fallback = appPaymentMethodFallbackName(id);
  return fallback === null ? null : appNames?.get(retiredPaymentMethod(id)?.replacement ?? id) ?? fallback;
}
