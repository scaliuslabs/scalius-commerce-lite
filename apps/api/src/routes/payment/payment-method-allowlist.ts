import type { Database } from "@scalius/database/client";
import {
  FRESH_GATEWAY_SETTINGS_READ_OPTIONS,
  getActivePaymentMethods,
} from "@scalius/core/modules/payments/gateway-settings";
import { ServiceUnavailableError } from "../../utils/api-error";

type StorefrontPaymentMethod = "stripe" | "sslcommerz" | "polar";

const GATEWAY_LABELS: Record<StorefrontPaymentMethod, string> = {
  stripe: "Stripe",
  sslcommerz: "SSLCommerz",
  polar: "Polar",
};

export async function assertGatewayEnabledForCheckout(
  db: Database,
  kv: KVNamespace | undefined,
  encryptionKey: string | undefined,
  method: StorefrontPaymentMethod,
): Promise<void> {
  const activeMethods = await getActivePaymentMethods(
    db,
    kv,
    encryptionKey,
    FRESH_GATEWAY_SETTINGS_READ_OPTIONS,
  );

  if (!activeMethods.enabledMethods.includes(method)) {
    throw new ServiceUnavailableError(`${GATEWAY_LABELS[method]} gateway is not enabled for checkout.`);
  }
}
