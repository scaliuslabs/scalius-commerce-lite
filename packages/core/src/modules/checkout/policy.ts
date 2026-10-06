import { assertPhoneCountryAllowed } from "@scalius/shared/customer-utils";
import {
  isCheckoutGatewayUsableForFlow,
  type CheckoutPaymentMethodId,
} from "./flow";
import {
  ServiceUnavailableError,
  UnauthorizedError,
  ValidationError,
} from "../../errors";
import type { StorefrontCheckoutAuthoritySnapshot } from "./authority";
import { BUILT_IN_PAYMENT_PROVIDERS, type PaymentProviders } from "../payments";

export interface StorefrontCheckoutSettingsSnapshot {
  checkoutMode: "guest_cod_only" | "gateways_only" | "all";
  partialPaymentEnabled: boolean;
  partialPaymentAmount: number;
}

export function assertStorefrontCheckoutPolicy(
  /** Null for an order placed without a phone (the shared contact rule decides later). */
  customerPhone: string | null,
  paymentMethod: CheckoutPaymentMethodId,
  authority: Pick<
    StorefrontCheckoutAuthoritySnapshot,
    "checkoutSettings" | "allowedCountries" | "activePaymentMethods"
  >,
  /** The request's gateways, for method names in refusals. */
  providers: PaymentProviders = BUILT_IN_PAYMENT_PROVIDERS,
): StorefrontCheckoutSettingsSnapshot {
  const checkoutSettings = authority.checkoutSettings;
  const snapshot: StorefrontCheckoutSettingsSnapshot = {
    checkoutMode: checkoutSettings.checkoutMode,
    partialPaymentEnabled: checkoutSettings.partialPaymentEnabled,
    partialPaymentAmount: checkoutSettings.partialPaymentAmount,
  };

  try {
    if (customerPhone) {
      assertPhoneCountryAllowed(customerPhone, {
        countries: authority.allowedCountries.allowedCountries,
        mode: authority.allowedCountries.allowedCountriesMode,
      });
    }
  } catch (error) {
    throw new ValidationError(
      error instanceof Error ? error.message : "Phone number is not accepted for checkout.",
    );
  }

  if (!(authority.activePaymentMethods.enabledMethods as readonly string[]).includes(paymentMethod)) {
    throw new ServiceUnavailableError(
      `${providers.label(paymentMethod)} is not enabled for checkout.`,
    );
  }

  if (!isCheckoutGatewayUsableForFlow({
    gatewayId: paymentMethod,
    checkoutMode: snapshot.checkoutMode,
    partialPaymentEnabled: snapshot.partialPaymentEnabled,
    partialPaymentAmount: snapshot.partialPaymentAmount,
  })) {
    throw new ValidationError(
      `${providers.label(paymentMethod)} is not available for the current checkout settings.`,
    );
  }

  return snapshot;
}

export function assertGuestStorefrontCheckoutPolicy(
  customerPhone: string | null,
  paymentMethod: CheckoutPaymentMethodId,
  authority: Pick<
    StorefrontCheckoutAuthoritySnapshot,
    "checkoutSettings" | "allowedCountries" | "activePaymentMethods"
  >,
  /** The request's gateways, for method names in refusals. */
  providers: PaymentProviders = BUILT_IN_PAYMENT_PROVIDERS,
): StorefrontCheckoutSettingsSnapshot {
  const snapshot = assertStorefrontCheckoutPolicy(customerPhone, paymentMethod, authority, providers);
  if (!authority.checkoutSettings.guestCheckoutEnabled) {
    throw new UnauthorizedError("Please sign in before checkout.");
  }
  return snapshot;
}
