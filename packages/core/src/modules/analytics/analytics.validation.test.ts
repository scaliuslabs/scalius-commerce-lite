import { describe, expect, it } from "vitest";

import {
  META_GRAPH_API_VERSION,
} from "../../integrations/meta/conversions-api";
import {
  CLOUDFLARE_WEB_ANALYTICS_SCRIPT_SRC,
  createAnalyticsSchema,
  normalizeCloudflareWebAnalyticsConfig,
} from "./analytics.validation";

describe("analytics validation", () => {
  it("accepts a Cloudflare Web Analytics token", () => {
    const result = createAnalyticsSchema.safeParse({
      name: "Cloudflare Web Analytics",
      type: "cloudflare_web_analytics",
      isActive: true,
      usePartytown: true,
      config: "abcDEF123_456-789",
      location: "body_end",
    });

    expect(result.success).toBe(true);
  });

  it("rejects invalid Cloudflare Web Analytics config", () => {
    const result = createAnalyticsSchema.safeParse({
      name: "Cloudflare Web Analytics",
      type: "cloudflare_web_analytics",
      isActive: true,
      usePartytown: false,
      config: "<script src=\"https://example.com/beacon.js\"></script>",
      location: "body_end",
    });

    expect(result.success).toBe(false);
  });

  it("normalizes a Cloudflare Web Analytics token into the beacon snippet", () => {
    expect(normalizeCloudflareWebAnalyticsConfig("site_token_123")).toBe(
      `<script defer src="${CLOUDFLARE_WEB_ANALYTICS_SCRIPT_SRC}" data-cf-beacon='{"token":"site_token_123"}'></script>`,
    );
  });
});

describe("Meta Graph API version", () => {
  it("uses the current supported Graph API version for Meta integrations", () => {
    expect(META_GRAPH_API_VERSION).toBe("v25.0");
  });
});
