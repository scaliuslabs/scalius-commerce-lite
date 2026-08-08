import { describe, expect, it } from "vitest";
import {
  classifySmsProviderFailure,
  isRetryableSmsHttpStatus,
  sanitizeSmsProviderDiagnostic,
} from "./retryability";

describe("SMS provider retryability", () => {
  it("does not retry merchant-actionable credential/configuration failures", () => {
    expect(classifySmsProviderFailure("error=405: Authorization required")).toBe(false);
    expect(classifySmsProviderFailure("Invalid API key")).toBe(false);
    expect(classifySmsProviderFailure("Insufficient balance")).toBe(false);
    expect(classifySmsProviderFailure("Sender ID is not approved")).toBe(false);
  });

  it("retries transient provider and network-style failures", () => {
    expect(isRetryableSmsHttpStatus(500)).toBe(true);
    expect(isRetryableSmsHttpStatus(429)).toBe(true);
    expect(classifySmsProviderFailure("Gateway timeout")).toBe(true);
    expect(classifySmsProviderFailure("Temporary server unavailable")).toBe(true);
  });

  it("redacts recipient and credential material from retained diagnostics", () => {
    expect(sanitizeSmsProviderDiagnostic(
      "Invalid mobile +8801712345678 token=provider-secret buyer@example.com",
    )).toBe("Invalid mobile [phone] token=[redacted] [email]");
  });
});
