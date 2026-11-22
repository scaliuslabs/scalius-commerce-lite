import type { Database } from "@scalius/database/client";
import { checkoutDocument } from "@scalius/core/modules/settings";
import { isCheckoutGatewayUsableForFlow } from "@scalius/core/modules/checkout";
import {
  BUILT_IN_PAYMENT_PROVIDERS,
  getPaymentMethodPreferences,
  type GatewaySettings,
  type PaymentGateway,
  type PaymentProviders,
} from "@scalius/core/modules/payments";
import { ServiceUnavailableError } from "../../utils/api-error";

export interface CheckoutFlowSettings {
  checkoutMode: "guest_cod_only" | "gateways_only" | "all";
  partialPaymentEnabled: boolean;
  partialPaymentAmount: number;
}

export interface CheckoutSelectionReads {
  preferences: Awaited<ReturnType<typeof getPaymentMethodPreferences>>;
  settings: Awaited<ReturnType<typeof checkoutDocument.read>>;
}

/** The store's method selection and checkout settings, read once for several methods. */
export async function readCheckoutSelection(db: Database): Promise<CheckoutSelectionReads> {
  const [preferences, settings] = await Promise.all([
    getPaymentMethodPreferences(db),
    checkoutDocument.read(db),
  ]);
  return { preferences, settings };
}

export async function assertGatewaySelectedForCheckout(
  db: Database,
  method: string,
  providers: PaymentProviders = BUILT_IN_PAYMENT_PROVIDERS,
  read?: CheckoutSelectionReads,
): Promise<CheckoutFlowSettings> {
  const { preferences, settings } = read ?? await readCheckoutSelection(db);

  if (!(preferences.enabledMethods as readonly string[]).includes(method)) {
    throw new ServiceUnavailableError(`${providers.label(method)} gateway is not enabled for checkout.`);
  }

  const checkoutSettings: CheckoutFlowSettings = {
    checkoutMode: settings.checkoutMode,
    partialPaymentEnabled: settings.partialPaymentEnabled,
    partialPaymentAmount: settings.partialPaymentAmount,
  };

  if (!isCheckoutGatewayUsableForFlow({
    gatewayId: method,
    checkoutMode: checkoutSettings.checkoutMode,
    partialPaymentEnabled: checkoutSettings.partialPaymentEnabled,
    partialPaymentAmount: checkoutSettings.partialPaymentAmount,
  })) {
    throw new ServiceUnavailableError(`${providers.label(method)} gateway is not available for the current checkout settings.`);
  }

  return checkoutSettings;
}

/** Saved gateway settings that are ready for buyer checkout; fails closed otherwise. */
export async function loadCheckoutGatewaySettings(
  db: Database,
  encryptionKey: string | undefined,
  gateway: PaymentGateway,
): Promise<GatewaySettings> {
  const settings = await gateway.loadSettings(db, encryptionKey);
  const readiness = gateway.readiness(settings);
  if (!settings || !readiness.configured) {
    throw new ServiceUnavailableError(
      readiness.blockedReason ?? `${gateway.label} is not configured. Please set credentials in the admin dashboard.`,
    );
  }
  if (!readiness.enabled) {
    throw new ServiceUnavailableError(`${gateway.label} gateway is disabled.`);
  }
  return settings;
}
