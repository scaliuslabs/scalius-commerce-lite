import { describe, expect, it } from "vitest";

import {
  BANGLA_CHECKOUT_LANGUAGE_DATA,
  CHECKOUT_LANGUAGE_KEYS,
  CHECKOUT_LANGUAGE_LONG_TEXT_KEYS,
  ENGLISH_CHECKOUT_LANGUAGE_DATA,
  formatCheckoutLanguageText,
  getCheckoutLanguagePreset,
  resolveCheckoutLanguageData,
} from "./checkout-language";

describe("checkout language presets", () => {
  it("keeps the built-in presets structurally complete", () => {
    expect(Object.keys(BANGLA_CHECKOUT_LANGUAGE_DATA)).toEqual(
      Object.keys(ENGLISH_CHECKOUT_LANGUAGE_DATA),
    );
    expect(CHECKOUT_LANGUAGE_KEYS.length).toBeGreaterThan(80);
  });

  it("keeps built-in preset values within the public API projection limits", () => {
    for (const preset of [ENGLISH_CHECKOUT_LANGUAGE_DATA, BANGLA_CHECKOUT_LANGUAGE_DATA]) {
      for (const key of CHECKOUT_LANGUAGE_KEYS) {
        const maximumLength = CHECKOUT_LANGUAGE_LONG_TEXT_KEYS.has(key) ? 1_000 : 120;
        expect(preset[key].length, key).toBeLessThanOrEqual(maximumLength);
      }
    }
  });

  it("selects a preset from a regional locale code", () => {
    expect(getCheckoutLanguagePreset("bn-BD").paymentStepText).toBe("পেমেন্ট");
    expect(getCheckoutLanguagePreset("fr").paymentStepText).toBe("Payment");
  });

  it("follows the current wording where a saved language still holds an earlier default", () => {
    const resolved = resolveCheckoutLanguageData("en", {
      customerPhoneHelp: "Enter your phone number with country code",
      zoneLabel: "Zone",
      addToCartText: "Add to Cart",
      discountAppliedText: "Discount applied successfully!",
      termsText: "By placing this order, you agree to our Terms of Service and Privacy Policy.",
      // A merchant's own wording stays.
      phoneRequiredText: "Your mobile number, please.",
    });
    expect(resolved.customerPhoneHelp).toBe(ENGLISH_CHECKOUT_LANGUAGE_DATA.customerPhoneHelp);
    expect(resolved.zoneLabel).toBe("Thana");
    expect(resolved.addToCartText).toBe(ENGLISH_CHECKOUT_LANGUAGE_DATA.addToCartText);
    expect(resolved.discountAppliedText).toBe(ENGLISH_CHECKOUT_LANGUAGE_DATA.discountAppliedText);
    expect(resolved.termsText).toContain("{terms}");
    expect(resolved.phoneRequiredText).toBe("Your mobile number, please.");
    expect(resolveCheckoutLanguageData("bn", { zoneLabel: "এলাকা" }).zoneLabel).toBe("থানা");
    // Title case saved from an older default follows today's sentence case.
    expect(resolveCheckoutLanguageData("en", { customerPhoneLabel: "Phone Number" }).customerPhoneLabel).toBe("Phone number");
  });

  it("never sends a buyer to 'contact the store' without the store's contact beside it", () => {
    for (const preset of [ENGLISH_CHECKOUT_LANGUAGE_DATA, BANGLA_CHECKOUT_LANGUAGE_DATA]) {
      for (const key of CHECKOUT_LANGUAGE_KEYS) {
        if (key === "storeContactLabelText") continue;
        expect(preset[key], key).not.toMatch(/contact the store|দোকানের (সঙ্গে|সাথে) যোগাযোগ/i);
      }
    }
    // A saved language holding the old dead-end wording follows the new default.
    const en = resolveCheckoutLanguageData("en", {
      trackOrderUnavailableText: "Order tracking isn't available right now. Contact the store.",
      orderReceiptRequestRejectedText: "The store could not accept this request. Contact the store if you still need help.",
    });
    expect(en.trackOrderUnavailableText).toBe("Order tracking isn't available right now.");
    expect(en.orderReceiptRequestRejectedText).toBe("The store could not accept this request.");
    expect(resolveCheckoutLanguageData("bn", {
      paymentRecoveryCodesUnavailableText: "এই মুহূর্তে কোড পাঠানো যাচ্ছে না। পেমেন্ট সম্পন্ন করতে দোকানের সাথে যোগাযোগ করুন।",
    }).paymentRecoveryCodesUnavailableText).toBe("এই মুহূর্তে কোড পাঠানো যাচ্ছে না।");
  });

  it("upgrades untouched English defaults in an older Bangla record", () => {
    const resolved = resolveCheckoutLanguageData("bn", {
      pageTitle: ENGLISH_CHECKOUT_LANGUAGE_DATA.pageTitle,
      paymentStepText: ENGLISH_CHECKOUT_LANGUAGE_DATA.paymentStepText,
      checkoutSectionTitle: "Checkout Information",
      customerNameLabel: "Full Name",
      processingText: "Processing...",
    });

    expect(resolved.pageTitle).toBe("কার্ট ও চেকআউট");
    expect(resolved.paymentStepText).toBe("পেমেন্ট");
    expect(resolved.checkoutSectionTitle).toBe("চেকআউটের তথ্য");
    expect(resolved.customerNameLabel).toBe("পুরো নাম");
    expect(resolved.processingText).toBe("প্রক্রিয়া চলছে…");
  });

  it("fills newly required empty-cart recovery copy from the locale preset", () => {
    const resolved = resolveCheckoutLanguageData("bn", {
      emptyCartText: "আপনার কার্ট খালি",
    });

    expect(resolved.emptyCartDescriptionText).toBe(
      "আপনি এখনো কার্টে কোনো পণ্য যোগ করেননি।",
    );
    expect(resolved.paymentRecoveryMessageText).toBe(
      "পেমেন্ট পেজ খোলার আগেই আপনার অর্ডারটি তৈরি হয়েছে। নতুন করে চেকআউট শুরু করার আগে পেমেন্টের অবস্থা দেখুন।",
    );
    expect(resolved.viewPaymentStatusText).toBe("পেমেন্টের অবস্থা দেখুন");
  });

  it("fills the buyer-verified payment recovery workflow from the locale preset", () => {
    const resolved = resolveCheckoutLanguageData("bn", {
      paymentRecoveryMessageText:
        "পেমেন্ট পেজ খোলার আগেই আপনার অর্ডারটি তৈরি হয়েছে। নতুন করে চেকআউট শুরু করার আগে পেমেন্টের অবস্থা দেখুন।",
    });

    expect(resolved.paymentRecoveryPageTitleText).toBe("পেমেন্ট পুনরুদ্ধার");
    expect(resolved.paymentRecoveryHeadingText).toBe("অর্ডারটি যাচাই করুন");
    expect(resolved.paymentRecoverySmsChannelText).toBe("অর্ডারের ফোনে SMS");
    expect(resolved.paymentRecoveryCodeSentText).toContain("যাচাইকরণ কোড");
    expect(resolved.paymentRecoveryMissingOrderText).toContain("অর্ডার রেফারেন্স");
    expect(resolved.paymentRecoveryVerificationFailedText).toContain("নতুন কোড");
  });

  it("fills the complete order-receipt workflow into an older Bangla record", () => {
    const resolved = resolveCheckoutLanguageData("bn", {
      pageTitle: "কার্ট ও চেকআউট",
    });

    expect(resolved.orderReceiptPlacedTitleText).toBe("অর্ডার দেওয়া হয়েছে");
    expect(resolved.orderReceiptCancelledMessageText).toContain("বাতিল করা হয়েছে");
    expect(resolved.orderReceiptPaymentStatusNoPaymentDueText).toBe("কোনো পেমেন্ট বাকি নেই");
    expect(resolved.orderReceiptCheckingPaymentText).toContain("যাচাই করা হচ্ছে");
    expect(resolved.orderReceiptSaveAccountTitleText).toContain("অ্যাকাউন্টে");
    expect(resolved.orderReceiptCancelRequestActionText).toBe("বাতিলের অনুরোধ করুন");
    expect(resolved.orderReceiptRequestApprovedText).toContain("গ্রহণ করেছে");
  });

  it("preserves genuine merchant overrides", () => {
    const resolved = resolveCheckoutLanguageData("bn", {
      pageTitle: "দ্রুত চেকআউট",
      paymentStepText: "পেমেন্ট ধাপ",
    });

    expect(resolved.pageTitle).toBe("দ্রুত চেকআউট");
    expect(resolved.paymentStepText).toBe("পেমেন্ট ধাপ");
  });

  it("interpolates known values and leaves missing placeholders visible", () => {
    expect(
      formatCheckoutLanguageText("Pay {amount} with {provider}", {
        amount: "৳500",
      }),
    ).toBe("Pay ৳500 with {provider}");
  });
});
