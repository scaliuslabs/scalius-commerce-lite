// @vitest-environment node

import { describe, expect, it } from "vitest";
import { BANGLA_CHECKOUT_LANGUAGE_DATA } from "@scalius/shared/checkout-language";
import { getPaymentRecoveryFailureText } from "./payment-recovery-messages";

describe("payment recovery localization", () => {
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
