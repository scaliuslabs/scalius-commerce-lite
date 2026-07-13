import type {
  CheckoutFlowSettingsPayload,
  CheckoutMode,
} from "@/lib/api-functions/settings";

export interface CheckoutFlowValues {
  guestCheckoutEnabled: boolean;
  checkoutMode: CheckoutMode;
  partialPaymentEnabled: boolean;
  partialPaymentAmount: number;
}

const CHECKOUT_FLOW_FIELDS = [
  "guestCheckoutEnabled",
  "checkoutMode",
  "partialPaymentEnabled",
  "partialPaymentAmount",
] as const satisfies ReadonlyArray<keyof CheckoutFlowValues>;

export function readCheckoutFlowValues(
  settings: CheckoutFlowSettingsPayload,
): CheckoutFlowValues {
  return {
    guestCheckoutEnabled: settings.guestCheckoutEnabled,
    checkoutMode: settings.checkoutMode,
    partialPaymentEnabled: settings.partialPaymentEnabled,
    partialPaymentAmount: settings.partialPaymentAmount,
  };
}

export function checkoutFlowValuesEqual(
  left: CheckoutFlowValues,
  right: CheckoutFlowValues,
): boolean {
  return CHECKOUT_FLOW_FIELDS.every((field) => left[field] === right[field]);
}

export function rebaseCheckoutFlowDraft(options: {
  base: CheckoutFlowValues;
  local: CheckoutFlowValues;
  latest: CheckoutFlowValues;
}): CheckoutFlowValues {
  return Object.fromEntries(
    CHECKOUT_FLOW_FIELDS.map((field) => [
      field,
      options.local[field] !== options.base[field]
        ? options.local[field]
        : options.latest[field],
    ]),
  ) as unknown as CheckoutFlowValues;
}
