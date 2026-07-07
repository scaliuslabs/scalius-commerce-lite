import { describe, expect, it } from "vitest";

import {
  processAnalyticsScript,
  shouldInjectAnalyticsScript,
  shouldUsePartytown,
} from "./analytics";
import { CLOUDFLARE_WEB_ANALYTICS_SCRIPT_SRC } from "../modules/analytics/analytics.validation";

const baseScript = {
  id: "analytics_1",
  name: "Analytics",
  type: "custom",
  isActive: true,
  usePartytown: true,
  config: "<script>window.test = true;</script>",
  location: "head",
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe("analytics script processing", () => {
  it("keeps Cloudflare Web Analytics on the main thread", () => {
    expect(
      shouldUsePartytown({
        ...baseScript,
        type: "cloudflare_web_analytics",
        usePartytown: true,
      }),
    ).toBe(false);
  });

  it("keeps Cloudflare Web Analytics beacon snippets on the main thread even as custom scripts", () => {
    expect(
      shouldUsePartytown({
        ...baseScript,
        type: "custom",
        usePartytown: true,
        config: `<script defer src="${CLOUDFLARE_WEB_ANALYTICS_SCRIPT_SRC}" data-cf-beacon='{"token":"site_token_123"}'></script>`,
      }),
    ).toBe(false);
  });

  it("adds Partytown type to ordinary scripts when enabled", () => {
    expect(processAnalyticsScript(baseScript)).toContain(
      '<script type="text/partytown">',
    );
  });

  it("defaults TikTok Pixel scripts into Partytown", () => {
    expect(
      shouldUsePartytown({
        ...baseScript,
        type: "tiktok_pixel",
        usePartytown: undefined as unknown as boolean,
      }),
    ).toBe(true);
  });

  it("does not inject legacy active placeholder snippets", () => {
    expect(
      shouldInjectAnalyticsScript({
        ...baseScript,
        type: "google_analytics",
        config: "<script>gtag('config', 'G-XXXXXXXXXX');</script>",
      }),
    ).toBe(false);
  });
});
