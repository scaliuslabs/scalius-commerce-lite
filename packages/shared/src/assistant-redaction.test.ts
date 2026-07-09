import { describe, expect, it } from "vitest";

import {
  containsAssistantSensitiveText,
  redactAssistantPersistedText,
  redactAssistantSensitiveText,
} from "./assistant-redaction";

describe("assistant sensitive-text redaction", () => {
  it.each([
    ["buyer@example.test", "[redacted-email]"],
    ["+8801712345678", "[redacted-phone]"],
    ["Bearer abc.def_123-456", "Bearer [redacted-token]"],
    ["chk_private_receipt", "[redacted-token]"],
    ["session_asst_privatecredential", "[redacted-token]"],
    ["approval_asst_privatecredential", "[redacted-token]"],
    ["aaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbb.cccccccccccc", "[redacted-token]"],
  ])("redacts %s", (input, expected) => {
    expect(containsAssistantSensitiveText(input)).toBe(true);
    expect(redactAssistantSensitiveText(input)).toContain(expected);
  });

  it("preserves ordinary product and navigation copy", () => {
    const text = "Open /products/gaming-headset and compare the two in-stock options.";
    expect(containsAssistantSensitiveText(text)).toBe(false);
    expect(redactAssistantSensitiveText(text)).toBe(text);
  });

  it("removes structured identity, address, credential, and recovery values before persistence", () => {
    const input = [
      'customer_name: "Private Buyer"',
      'address: "12 Private Road, Dhaka"',
      "password = hunter2",
      "otp is 654321",
      'receipt_token: "chk_privateproof"',
      'apiKey: "not-a-real-key"',
    ].join("\n");

    const redacted = redactAssistantPersistedText(input);

    expect(redacted).not.toContain("Private Buyer");
    expect(redacted).not.toContain("12 Private Road");
    expect(redacted).not.toContain("hunter2");
    expect(redacted).not.toContain("654321");
    expect(redacted).not.toContain("chk_privateproof");
    expect(redacted).not.toContain("not-a-real-key");
    expect(redacted).toContain("[redacted]");
  });
});
