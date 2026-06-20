import { describe, expect, it } from "vitest";

import {
  PAYMENT_SESSION_PROVIDER_REQUEST_TIMEOUT_MS,
  withPaymentProviderDeadline,
} from "./payment-provider-deadline";

describe("payment provider deadline guard", () => {
  it("passes the request timeout to providers", async () => {
    const result = await withPaymentProviderDeadline(
      "TestPay",
      async (_signal, requestTimeoutMs) => requestTimeoutMs,
      { deadlineMs: 50, requestTimeoutMs: 25 },
    );

    expect(result).toBe(25);
  });

  it("aborts slow providers with a retryable service-unavailable error", async () => {
    await expect(
      withPaymentProviderDeadline(
        "TestPay",
        async (signal) => new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
        { deadlineMs: 5, requestTimeoutMs: PAYMENT_SESSION_PROVIDER_REQUEST_TIMEOUT_MS },
      ),
    ).rejects.toMatchObject({
      status: 503,
      code: "SERVICE_UNAVAILABLE",
      message: "TestPay did not respond in time. Please try again shortly.",
    });
  });
});
