import type { Database } from "@scalius/database/client";
import { siteSettings } from "@scalius/database/schema";
import {
  getPaymentMethodPreferences,
  getSSLCommerzCheckoutReadiness,
  getSSLCommerzSettings,
  getStripeCheckoutReadiness,
  getStripeSettings,
  type SSLCommerzSettings,
  type StripeSettings,
} from "@scalius/core/modules/payments/gateway-settings";
import { isCheckoutGatewayUsableForFlow } from "@scalius/core/modules/settings/checkout-flow";
import { ServiceUnavailableError } from "../../utils/api-error";

export type StorefrontPaymentMethod = "stripe" | "sslcommerz";

export interface CheckoutFlowSettings {
  checkoutMode: "guest_cod_only" | "gateways_only" | "all";
  partialPaymentEnabled: boolean;
  partialPaymentAmount: number;
}

type GatewaySettingsByMethod = {
  stripe: StripeSettings;
  sslcommerz: SSLCommerzSettings;
};

const GATEWAY_LABELS: Record<StorefrontPaymentMethod, string> = {
  stripe: "Stripe",
  sslcommerz: "SSLCommerz",
};

export async function assertGatewaySelectedForCheckout(
  db: Database,
  method: StorefrontPaymentMethod,
): Promise<CheckoutFlowSettings> {
  const [preferences, settings] = await Promise.all([
    getPaymentMethodPreferences(db),
    db
      .select({
        checkoutMode: siteSettings.checkoutMode,
        partialPaymentEnabled: siteSettings.partialPaymentEnabled,
        partialPaymentAmount: siteSettings.partialPaymentAmount,
      })
      .from(siteSettings)
      .get(),
  ]);

  if (!preferences.enabledMethods.includes(method)) {
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

export function assertGatewayCheckoutSettings(
  method: "stripe",
  settings: StripeSettings | null,
): asserts settings is StripeSettings;
export function assertGatewayCheckoutSettings(
  method: "sslcommerz",
  settings: SSLCommerzSettings | null,
): asserts settings is SSLCommerzSettings;
export function assertGatewayCheckoutSettings(
  method: StorefrontPaymentMethod,
  settings: StripeSettings | SSLCommerzSettings | null,
): void {
  if (method === "stripe") {
    const readiness = getStripeCheckoutReadiness(settings as StripeSettings | null);
    if (!settings || !readiness.configured) {
      throw new ServiceUnavailableError(readiness.blockedReason ?? "Stripe is not configured. Please set credentials in the admin dashboard.");
    }
    if (!readiness.enabled) {
      throw new ServiceUnavailableError("Stripe gateway is disabled.");
    }
    return;
  }

  const readiness = getSSLCommerzCheckoutReadiness(settings as SSLCommerzSettings | null);
  if (!settings || !readiness.configured) {
    throw new ServiceUnavailableError(readiness.blockedReason ?? "SSLCommerz is not configured. Please set credentials in the admin dashboard.");
  }
  if (!readiness.enabled) {
    throw new ServiceUnavailableError("SSLCommerz gateway is disabled.");
  }
}

export function loadCheckoutGatewaySettings(
  db: Database,
  encryptionKey: string | undefined,
  method: "stripe",
): Promise<StripeSettings>;
export function loadCheckoutGatewaySettings(
  db: Database,
  encryptionKey: string | undefined,
  method: "sslcommerz",
): Promise<SSLCommerzSettings>;
export function loadCheckoutGatewaySettings(
  db: Database,
  encryptionKey: string | undefined,
  method: StorefrontPaymentMethod,
): Promise<GatewaySettingsByMethod[StorefrontPaymentMethod]>;
export async function loadCheckoutGatewaySettings(
  db: Database,
  encryptionKey: string | undefined,
  method: StorefrontPaymentMethod,
): Promise<GatewaySettingsByMethod[StorefrontPaymentMethod]> {
  if (method === "stripe") {
    const settings = await getStripeSettings(db, encryptionKey);
    assertGatewayCheckoutSettings(method, settings);
    return settings;
  }
  const settings = await getSSLCommerzSettings(db, encryptionKey);
  assertGatewayCheckoutSettings(method, settings);
  return settings;
}
