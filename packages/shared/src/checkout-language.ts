import {
  BANGLA_CHECKOUT_LANGUAGE_DATA,
  ENGLISH_CHECKOUT_LANGUAGE_DATA,
  type CheckoutLanguageData,
  type CheckoutLanguageKey,
} from "#checkout-language-presets";
import { checkoutLanguageBaseCode } from "./checkout-language-format";

export { checkoutLanguageBaseCode };
// The catalogue's data lives in its own module, which the API Worker ships as a Text module.
export { BANGLA_CHECKOUT_LANGUAGE_DATA, ENGLISH_CHECKOUT_LANGUAGE_DATA, type CheckoutLanguageData, type CheckoutLanguageKey };

export const CHECKOUT_LANGUAGE_KEYS = /* @__PURE__ */ Object.freeze(
  /* @__PURE__ */ Object.keys(ENGLISH_CHECKOUT_LANGUAGE_DATA) as CheckoutLanguageKey[],
);

/**
 * The checkout-language copy the product page uses, delivered with the
 * layout (`storefrontCopy`) so merchant edits reach cached product pages
 * without a second read: buy buttons and offers, buyer inputs (Wave A §3)
 * and the fulfilment facts beside the buy box. One list for the core
 * resolver, the API contract and the storefront type.
 */
export const PRODUCT_PAGE_COPY_KEYS = [
  "addToCartText",
  "quickBuyFailedText",
  "buyNowText",
  "unavailableText",
  "chooseOptionText",
  "fromPriceText",
  "quantityLabelText",
  "quantityLimitText",
  "saleOfferText",
  "saleOfferSpendText",
  "saleOfferGetText",
  "saleOfferGetSpendText",
  "freeBenefitText",
  "percentBenefitText",
  "customizationRequiredText",
  "customizationRequiredChoiceText",
  "customizationRequiredCheckText",
  "customizationTooLongText",
  "customizationCounterText",
  "customizationSurchargeText",
  "customizationOptionalText",
  "customizationChoosePlaceholderText",
  "customizationUnavailableText",
  "onlinePaymentRequiredText",
  "deliveryUnavailableText",
  "customizationNeededText",
  "customizationInvalidText",
  "updateCartItemText",
  "pickupAvailableText",
  "noDeliveryNeededBadgeText",
  "payAtServiceText",
  "productBundleTierText",
  "productBundleSetPriceText",
  // A gift card's recipient inputs (gift-card-recipient.ts `localizedGiftCardRecipientFields`).
  "lineGiftCardRecipientNameText",
  "lineGiftCardRecipientEmailText",
  "lineGiftCardRecipientPhoneText",
  "lineGiftCardMessageText",
  "recipientHelpText",
  "recipientEmailHelpText",
  "recipientPhoneHelpText",
] as const satisfies readonly CheckoutLanguageKey[];

export type ProductPageCopyKey = (typeof PRODUCT_PAGE_COPY_KEYS)[number];
export type ProductPageCopy = Pick<CheckoutLanguageData, ProductPageCopyKey> & {
  /** Base code of the active checkout language ("en", "bn"). */
  languageCode: string;
};

/** The product page's copy from a resolved checkout language. */
export function pickProductPageCopy(code: unknown, copy: CheckoutLanguageData): ProductPageCopy {
  const picked = Object.fromEntries(PRODUCT_PAGE_COPY_KEYS.map((key) => [key, copy[key]])) as Pick<
    CheckoutLanguageData,
    ProductPageCopyKey
  >;
  return { languageCode: checkoutLanguageBaseCode(code), ...picked };
}

export const CHECKOUT_LANGUAGE_LONG_TEXT_KEYS =/* @__PURE__ */ new Set<CheckoutLanguageKey>([
  "termsText",
  "emptyCartDescriptionText",
  "paymentRecoveryMessageText",
  "paymentRecoveryIntroText",
  "paymentRecoveryUnavailableText",
  "checkoutAppUnavailableText",
  "checkoutAppOfferChangedText",
  "paymentRecoveryMissingOrderText",
  "paymentRecoveryCodeSentText",
  "paymentRecoveryVerificationFailedText",
  "orderReceiptBrowserRecoveryMessageText",
  "orderReceiptBrowserOnlyMessageText",
  "orderReceiptPrivateUnavailableMessageText",
  "orderReceiptExpiredMessageText",
  "orderReceiptUnavailableMessageText",
  "orderReceiptDeliveryNotRecordedText",
  "orderReceiptStripePaymentMethodRequiredText",
  "orderReceiptStripeAuthenticationRequiredText",
  "orderReceiptConfirmationDelayedText",
  "orderReceiptCardLoadFailedText",
  "orderReceiptPaymentIssueMessageText",
  "orderReceiptPaymentFailedMessageText",
  "orderReceiptPaymentPendingMessageText",
  "orderReceiptConfirmedMessageText",
  "orderReceiptProcessingMessageText",
  "orderReceiptShippedMessageText",
  "orderReceiptDeliveredMessageText",
  "orderReceiptPickedUpMessageText",
  "orderReceiptFulfilledMessageText",
  "noDeliveryNeededText",
  "orderPickupNotReadyText",
  "orderReceiptCompletedMessageText",
  "orderReceiptCancelledMessageText",
  "orderReceiptRefundedMessageText",
  "orderReceiptReturnedMessageText",
  "orderReceiptPartiallyRefundedMessageText",
  "orderReceiptUpdatedMessageText",
  "orderReceiptPlacedMessageText",
  "orderReceiptSaveAccountHelpText",
  "orderReceiptSavedText",
  "orderReceiptRequestSubmittedText",
  "orderReceiptRequestApprovedText",
  "orderReceiptRequestRejectedText",
  "orderReceiptRequestSettledText",
  "orderReceiptMissingProofText",
  "checkoutUnavailableMessage",
  "existingCheckoutMessage",
  "noScriptText",
  "accountUnavailableText",
  "openingPaymentOptionsMessage",
  "checkoutDetailsMissingText",
  "checkoutDetailsUnreadableText",
  "noPaymentMethodsText",
  "cartOnlinePaymentRequiredText",
  "cartDeliveryUnavailableText",
  "totalUpdatedForChoiceText",
  "onlinePaymentRequiredText",
  "deliveryUnavailableText",
  "paymentMethodUnavailableMessage",
  "processingPaymentMessage",
  "placingOrderMessage",
  "openingSecurePaymentMessage",
  "leavingToPayMessage",
  "redirectSlowMessage",
  "unsafeRedirectText",
  "totalVerificationFailedText",
  "cardAuthenticationFailedText",
  "cardPaymentFailedText",
  "paymentStartFailedText",
  "paymentRateExpiredText",
  "checkoutStorageBlockedText",
  "addressSuggestionsText",
  "checkoutFieldsMissingText",
  "checkoutDeliveryChangedText",
  "cashOnDeliveryUnavailableText",
  "deliveryOverWeightText",
  "deliveryOverWeightNoneText",
  "deliveryItemsUnavailableText",
  "deliveryItemsUnavailableNoneText",
]);

const CHECKOUT_LANGUAGE_PRESETS: Record<string, CheckoutLanguageData> = {
  en: ENGLISH_CHECKOUT_LANGUAGE_DATA,
  bn: BANGLA_CHECKOUT_LANGUAGE_DATA,
};

function parseStoredLanguageData(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function getCheckoutLanguagePreset(code: unknown): CheckoutLanguageData {
  const preset = CHECKOUT_LANGUAGE_PRESETS[checkoutLanguageBaseCode(code)];
  return { ...(preset ?? ENGLISH_CHECKOUT_LANGUAGE_DATA) };
}

/**
 * Defaults a newer preset replaced. Saving a checkout language stores every
 * value as resolved, so a store saved before the change holds the old default
 * as if the merchant had typed it; that exact text reads as the current preset.
 */
const RETIRED_CHECKOUT_LANGUAGE_DEFAULTS: Partial<Record<CheckoutLanguageKey, readonly string[]>> = {
  // They promised "a minute" whatever wait the API named.
  reviewRateLimitedText: ["Too many tries. Wait a minute, then try again.", "অনেকবার চেষ্টা করা হয়েছে। এক মিনিট অপেক্ষা করে আবার চেষ্টা করুন।"],
  giftCardRateLimitedText: ["Too many tries. Wait a minute, then try again.", "অনেকবার চেষ্টা করা হয়েছে। এক মিনিট অপেক্ষা করে আবার চেষ্টা করুন।"],
  warrantyClaimRateLimitedText: ["Too many tries. Wait a minute, then try again.", "অনেকবার চেষ্টা করা হয়েছে। এক মিনিট অপেক্ষা করে আবার চেষ্টা করুন।"],
};

/**
 * Stored values are merchant overrides on the locale's preset: a blank value
 * keeps the preset's wording, any other value replaces it, except a default a
 * newer preset retired, which reads as the preset's wording now.
 */
export function resolveCheckoutLanguageData(
  code: unknown,
  storedValue: unknown,
): CheckoutLanguageData {
  const resolved = getCheckoutLanguagePreset(checkoutLanguageBaseCode(code));
  const stored = parseStoredLanguageData(storedValue);

  for (const key of CHECKOUT_LANGUAGE_KEYS) {
    const value = stored[key];
    if (typeof value !== "string" || value.trim() === "") continue;
    if (RETIRED_CHECKOUT_LANGUAGE_DEFAULTS[key]?.includes(value.trim())) continue;
    resolved[key] = value;
  }

  return resolved;
}

// Separate module so browser bundles can format copy without the presets.
export { formatCheckoutLanguageText } from "./checkout-language-format";
