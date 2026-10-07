// The shape of a payment method id the storefront passes on before the API
// decides: a built-in id (`stripe`, `cod`, a retired `sslcommerz`, …) or an app
// provider's `<plugin id>:<provider id>`. The API alone says whether a
// method is enabled and ready; this only keeps arbitrary text out of paths.

import { isQualifiedProviderId } from "@scalius/shared/plugins/providers/kinds";

const BUILT_IN_METHOD_ID = /^[a-z][a-z0-9_-]{0,63}$/;

export function isPaymentMethodIdShape(value: unknown): value is string {
  return typeof value === "string" && (BUILT_IN_METHOD_ID.test(value) || isQualifiedProviderId(value));
}
