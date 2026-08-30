import { describe, expect, it } from "vitest";

import {
  BANGLA_CHECKOUT_LANGUAGE_DATA,
  CHECKOUT_LANGUAGE_KEYS,
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

  it("selects a preset from a regional locale code", () => {
    expect(getCheckoutLanguagePreset("bn-BD").paymentStepText).toBe("পেমেন্ট");
    expect(getCheckoutLanguagePreset("fr").paymentStepText).toBe("Payment");
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
