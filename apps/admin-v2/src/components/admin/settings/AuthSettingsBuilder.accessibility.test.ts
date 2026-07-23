import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("./AuthSettingsBuilder.tsx", import.meta.url),
  "utf8",
);

describe("customer sign-in settings accessibility", () => {
  it("associates visible labels with every policy selector", () => {
    for (const id of [
      "customer-auth-preset",
      "default-otp-channel",
      "sms-provider",
    ]) {
      expect(source).toContain(`htmlFor="${id}"`);
      expect(source).toContain(`id="${id}"`);
    }
  });

  it("names the verification and email collection groups", () => {
    expect(source).toContain('aria-labelledby="verification-channels-label"');
    expect(source).toContain('id="verification-channels-label"');
    expect(source).toContain('aria-labelledby="email-collection-label"');
    expect(source).toContain('id="email-collection-label"');
  });
});
