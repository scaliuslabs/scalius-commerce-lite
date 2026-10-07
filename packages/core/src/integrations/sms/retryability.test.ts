import { describe, expect, it } from "vitest";
import { sanitizeSmsProviderDiagnostic } from "./retryability";

describe("SMS provider diagnostics", () => {
  it("redacts recipient and credential material from retained diagnostics", () => {
    expect(sanitizeSmsProviderDiagnostic(
      "Invalid mobile +8801712345678 token=provider-secret buyer@example.com",
    )).toBe("Invalid mobile [phone] token=[redacted] [email]");
  });
});
