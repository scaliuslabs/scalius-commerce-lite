import { describe, expect, it } from "vitest";

import type { AnalyticsConfig } from "@/lib/api";
import { optimizeAnalyticsScriptDelivery } from "./analytics-script-delivery";

const base: AnalyticsConfig = {
  id: "analytics_cloudflare",
  type: "cloudflare_web_analytics",
  config:
    '<script type="module" src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon=\'{"token":"0123456789abcdef0123456789abcdef"}\'></script>',
  location: "body_end",
  usePartytown: false,
};

describe("analytics script delivery", () => {
  it("keeps the Cloudflare module below buyer-critical fetches", () => {
    expect(optimizeAnalyticsScriptDelivery(base).config).toContain(
      '<script type="module" fetchpriority="low" src=',
    );
  });

  it("does not rewrite unrelated or already prioritized snippets", () => {
    const custom = { ...base, type: "custom" };
    expect(optimizeAnalyticsScriptDelivery(custom)).toBe(custom);

    const optimized = {
      ...base,
      config: base.config.replace(
        'type="module"',
        'type="module" fetchpriority="low"',
      ),
    };
    expect(optimizeAnalyticsScriptDelivery(optimized)).toBe(optimized);
  });
});
