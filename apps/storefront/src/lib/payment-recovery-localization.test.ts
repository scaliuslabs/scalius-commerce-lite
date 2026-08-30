// @vitest-environment node

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BANGLA_CHECKOUT_LANGUAGE_DATA } from "@scalius/shared/checkout-language";
import { storefrontSourcePath } from "./test-source-paths";
import { getPaymentRecoveryFailureText } from "./payment-recovery-messages";

const pageSource = readFileSync(
  storefrontSourcePath("pages/payment-recovery.astro"),
  "utf8",
);

describe("payment recovery localization", () => {
  it("resolves server and browser copy from the active checkout language", () => {
    const layoutOpeningTag = pageSource.match(/<Layout[\s\S]*?>/)?.[0] ?? "";

    expect(pageSource).toContain("getActiveCheckoutLanguage()");
    expect(pageSource).toContain("checkoutLanguageBaseCode(checkoutLanguage.code)");
    expect(pageSource).toContain("window.__CHECKOUT_LANGUAGE__=");
    expect(pageSource).toContain("copy.paymentRecoveryHeadingText");
    expect(pageSource).toContain("copy.paymentRecoveryMissingOrderText");
    expect(pageSource).not.toContain(">Hosted payment recovery<");
    expect(pageSource).not.toContain(">Verify this order<");
    expect(pageSource).not.toContain("Ask the store to send a fresh payment recovery link.");
    expect(layoutOpeningTag).not.toContain("noindex");
    expect(pageSource.match(/name="robots"/g)).toHaveLength(1);
    expect(pageSource).toContain('content="noindex,nofollow"');
  });

  it("maps backend classification to safe Bangla buyer copy", () => {
    expect(
      getPaymentRecoveryFailureText({
        copy: BANGLA_CHECKOUT_LANGUAGE_DATA,
        operation: "send",
        errorCode: "RATE_LIMIT_EXCEEDED",
        status: 429,
      }),
    ).toBe(BANGLA_CHECKOUT_LANGUAGE_DATA.paymentRecoveryRateLimitedText);

    expect(
      getPaymentRecoveryFailureText({
        copy: BANGLA_CHECKOUT_LANGUAGE_DATA,
        operation: "verify",
        errorCode: "VALIDATION_ERROR",
        status: 400,
      }),
    ).toBe(BANGLA_CHECKOUT_LANGUAGE_DATA.paymentRecoveryVerificationFailedText);

    expect(
      getPaymentRecoveryFailureText({
        copy: BANGLA_CHECKOUT_LANGUAGE_DATA,
        operation: "send",
        errorCode: "UNEXPECTED_PROVIDER_COPY",
        status: 502,
      }),
    ).toBe(BANGLA_CHECKOUT_LANGUAGE_DATA.paymentRecoverySendFailedText);
  });
});
