import { assertPhoneCountryAllowed } from "@scalius/shared/customer-utils";
import {
  isCheckoutGatewayUsableForFlow,
  type CheckoutPaymentMethodId,
} from "../settings/checkout-flow";
import {
  ServiceUnavailableError,
  UnauthorizedError,
  ValidationError,
} from "../../errors";
import type { StorefrontCheckoutAuthoritySnapshot } from "./checkout-authority";

const PAYMENT_METHOD_LABELS: Record<CheckoutPaymentMethodId, string> = {
  cod: "Cash on delivery",
  stripe: "Stripe",
  sslcommerz: "SSLCommerz",
  polar: "Polar",
};

export interface StorefrontCheckoutSettingsSnapshot {
  checkoutMode: "guest_cod_only" | "gateways_only" | "all";
  partialPaymentEnabled: boolean;
  partialPaymentAmount: number;
}

export function assertStorefrontCheckoutPolicy(
  customerPhone: string,
  paymentMethod: CheckoutPaymentMethodId,
  authority: Pick<
    StorefrontCheckoutAuthoritySnapshot,
    "checkoutSettings" | "allowedCountries" | "activePaymentMethods"
  >,
): StorefrontCheckoutSettingsSnapshot {
  const checkoutSettings = authority.checkoutSettings;
  const snapshot: StorefrontCheckoutSettingsSnapshot = {
    checkoutMode: checkoutSettings.checkoutMode,
    partialPaymentEnabled: checkoutSettings.partialPaymentEnabled,
    partialPaymentAmount: checkoutSettings.partialPaymentAmount,
  };

  try {
    assertPhoneCountryAllowed(customerPhone, {
      countries: authority.allowedCountries.allowedCountries,
      mode: authority.allowedCountries.allowedCountriesMode,
    });
  } catch (error) {
    throw new ValidationError(
      error instanceof Error ? error.message : "Phone number is not accepted for checkout.",
    );
  }

  if (!authority.activePaymentMethods.enabledMethods.includes(paymentMethod)) {
    throw new ServiceUnavailableError(
      `${PAYMENT_METHOD_LABELS[paymentMethod]} is not enabled for checkout.`,
    );
  }

  if (!isCheckoutGatewayUsableForFlow({
    gatewayId: paymentMethod,
    checkoutMode: snapshot.checkoutMode,
    partialPaymentEnabled: snapshot.partialPaymentEnabled,
    partialPaymentAmount: snapshot.partialPaymentAmount,
  })) {
    throw new ValidationError(
      `${PAYMENT_METHOD_LABELS[paymentMethod]} is not available for the current checkout settings.`,
    );
  }

  return snapshot;
}

export function assertGuestStorefrontCheckoutPolicy(
  customerPhone: string,
  paymentMethod: CheckoutPaymentMethodId,
  authority: Pick<
    StorefrontCheckoutAuthoritySnapshot,
    "checkoutSettings" | "allowedCountries" | "activePaymentMethods"
  >,
): StorefrontCheckoutSettingsSnapshot {
  const snapshot = assertStorefrontCheckoutPolicy(customerPhone, paymentMethod, authority);
  if (!authority.checkoutSettings.guestCheckoutEnabled) {
    throw new UnauthorizedError("Please sign in before checkout.");
  }
  return snapshot;
}
