import { describe, expect, it } from "vitest";

import {
  getMetaConversionsEnableIssue,
  getMetaConversionsSettingsIssue,
  isMetaConversionsPlaceholderCredential,
} from "./readiness";
import type { FormData } from "../MetaConversionsSettingsForm";

const baseFormData: FormData = {
  pixelId: "",
  accessToken: "",
  testEventCode: "",
  isEnabled: false,
  logRetentionDays: 30,
};

describe("Meta Conversions settings readiness", () => {
  it("requires Pixel ID and access token before enabling", () => {
    expect(getMetaConversionsEnableIssue(baseFormData)).toBe(
      "Meta Conversions API needs Pixel ID and access token before it can be enabled.",
    );
  });

  it("allows masked existing tokens to satisfy enable readiness", () => {
    expect(getMetaConversionsEnableIssue({
      ...baseFormData,
      pixelId: "1234567890",
      accessToken: "••••••••••••",
    })).toBeNull();
  });

  it("rejects simple placeholders without rejecting real-looking values by substring", () => {
    expect(isMetaConversionsPlaceholderCredential("pixel_123")).toBe(true);
    expect(isMetaConversionsPlaceholderCredential("access_token")).toBe(true);
    expect(isMetaConversionsPlaceholderCredential("EAABtestLiveToken123")).toBe(false);
    expect(isMetaConversionsPlaceholderCredential("TEST12345")).toBe(false);

    expect(getMetaConversionsSettingsIssue({
      ...baseFormData,
      pixelId: "1234567890",
      accessToken: "EAABtestLiveToken123",
      testEventCode: "test",
    })).toBe(
      "Test event code looks like a dummy or placeholder value. Use the code from Meta Events Manager test events.",
    );
  });
});
