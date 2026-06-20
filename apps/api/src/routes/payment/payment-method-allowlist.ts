import type { Database } from "@scalius/database/client";
import { siteSettings } from "@scalius/database/schema";
import {
  FRESH_GATEWAY_SETTINGS_READ_OPTIONS,
  getActivePaymentMethods,
} from "@scalius/core/modules/payments/gateway-settings";
import { isCheckoutGatewayUsableForFlow } from "@scalius/core/modules/settings/checkout-flow";
import { ServiceUnavailableError } from "../../utils/api-error";

type StorefrontPaymentMethod = "stripe" | "sslcommerz" | "polar";

export interface CheckoutFlowSettings {
  checkoutMode: "guest_cod_only" | "gateways_only" | "all";
  partialPaymentEnabled: boolean;
  partialPaymentAmount: number;
}

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
): Promise<CheckoutFlowSettings> {
  const [activeMethods, settings] = await Promise.all([
    getActivePaymentMethods(
      db,
      kv,
      encryptionKey,
      FRESH_GATEWAY_SETTINGS_READ_OPTIONS,
    ),
    db
      .select({
        checkoutMode: siteSettings.checkoutMode,
        partialPaymentEnabled: siteSettings.partialPaymentEnabled,
        partialPaymentAmount: siteSettings.partialPaymentAmount,
      })
      .from(siteSettings)
      .get(),
  ]);

  if (!activeMethods.enabledMethods.includes(method)) {
    throw new ServiceUnavailableError(`${GATEWAY_LABELS[method]} gateway is not enabled for checkout.`);
  }

  const checkoutSettings: CheckoutFlowSettings = {
    checkoutMode: settings?.checkoutMode ?? "all",
    partialPaymentEnabled: settings?.partialPaymentEnabled ?? false,
    partialPaymentAmount: settings?.partialPaymentAmount ?? 0,
  };

  if (!isCheckoutGatewayUsableForFlow({
    gatewayId: method,
    checkoutMode: checkoutSettings.checkoutMode,
    partialPaymentEnabled: checkoutSettings.partialPaymentEnabled,
    partialPaymentAmount: checkoutSettings.partialPaymentAmount,
  })) {
    throw new ServiceUnavailableError(`${GATEWAY_LABELS[method]} gateway is not available for the current checkout settings.`);
  }

  return checkoutSettings;
}
