import { describe, expect, it } from "vitest";

import { META_GRAPH_API_VERSION } from "../../integrations/meta/conversions-api";
import {
  CLOUDFLARE_WEB_ANALYTICS_SCRIPT_SRC,
  analyticsScriptTypes,
  createAnalyticsSchema,
  isPubliclyInjectableAnalyticsConfig,
  normalizeCloudflareWebAnalyticsConfig,
  updateAnalyticsSchema,
} from "./analytics.validation";
import {
  buildMetaPixelParityDiagnostics,
  extractFacebookPixelIdsFromScript,
} from "./meta-pixel-parity";

describe("analytics validation", () => {
  it("accepts Google Tag Manager as a first-class script type", () => {
    expect(analyticsScriptTypes).toContain("google_tag_manager");

    const result = createAnalyticsSchema.safeParse({
      name: "Google Tag Manager",
      type: "google_tag_manager",
      isActive: true,
      usePartytown: true,
      config: "<script>window.dataLayer = window.dataLayer || [];</script>",
      location: "head",
    });

    expect(result.success).toBe(true);
  });

  it("accepts TikTok Pixel as a first-class script type", () => {
    expect(analyticsScriptTypes).toContain("tiktok_pixel");

    const result = createAnalyticsSchema.safeParse({
      name: "TikTok Pixel",
      type: "tiktok_pixel",
      isActive: true,
      usePartytown: true,
      config: "<script>ttq.load('C1234567890ABCDEFG');ttq.page();</script>",
      location: "head",
    });

    expect(result.success).toBe(true);
  });

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
      config: '<script src="https://example.com/beacon.js"></script>',
      location: "body_end",
    });

    expect(result.success).toBe(false);
  });

  it("normalizes a Cloudflare Web Analytics token into the beacon snippet", () => {
    expect(normalizeCloudflareWebAnalyticsConfig("site_token_123")).toBe(
      `<script defer src="${CLOUDFLARE_WEB_ANALYTICS_SCRIPT_SRC}" data-cf-beacon='{"token":"site_token_123"}'></script>`,
    );
  });

  it("rejects active snippets that still contain provider placeholder IDs", () => {
    const cases = [
      {
        type: "google_analytics",
        config: "<script>gtag('config', 'G-XXXXXXXXXX');</script>",
      },
      {
        type: "google_tag_manager",
        config:
          "<script>})(window,document,'script','dataLayer','GTM-XXXXXXX');</script>",
      },
      {
        type: "facebook_pixel",
        config:
          "<script>fbq('init', 'PIXEL_ID');fbq('track', 'PageView');</script>",
      },
      {
        type: "tiktok_pixel",
        config: "<script>ttq.load('PIXEL_ID');ttq.page();</script>",
      },
      {
        type: "custom",
        config:
          "<script>window.analyticsPixel = 'YOUR_FACEBOOK_PIXEL_ID';</script>",
      },
    ] as const;

    for (const testCase of cases) {
      const result = createAnalyticsSchema.safeParse({
        name: "Analytics Script",
        type: testCase.type,
        isActive: true,
        usePartytown: true,
        config: testCase.config,
        location: "head",
      });

      expect(result.success, testCase.type).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toContain("placeholder");
      }
    }
  });

  it("allows placeholder snippets to be saved inactive but not updated active", () => {
    const inactiveDraft = createAnalyticsSchema.safeParse({
      name: "Draft Facebook Pixel",
      type: "facebook_pixel",
      isActive: false,
      usePartytown: true,
      config: "<script>fbq('init', 'PIXEL_ID');</script>",
      location: "head",
    });
    const activeUpdate = updateAnalyticsSchema.safeParse({
      id: "analytics_1",
      name: "Draft Facebook Pixel",
      type: "facebook_pixel",
      isActive: true,
      usePartytown: true,
      config: "<script>fbq('init', 'PIXEL_ID');</script>",
      location: "head",
    });

    expect(inactiveDraft.success).toBe(true);
    expect(activeUpdate.success).toBe(false);
  });

  it("marks legacy active placeholder configs as unsafe for public injection", () => {
    expect(
      isPubliclyInjectableAnalyticsConfig({
        isActive: true,
        config: "<script>gtag('config', 'G-XXXXXXXXXX');</script>",
      }),
    ).toBe(false);
    expect(
      isPubliclyInjectableAnalyticsConfig({
        isActive: false,
        config: "<script>gtag('config', 'G-XXXXXXXXXX');</script>",
      }),
    ).toBe(true);
  });
});

describe("Meta Graph API version", () => {
  it("uses the current supported Graph API version for Meta integrations", () => {
    expect(META_GRAPH_API_VERSION).toBe("v25.0");
  });
});

describe("Meta Pixel parity diagnostics", () => {
  it("extracts Pixel IDs from fbq init snippets", () => {
    expect(
      extractFacebookPixelIdsFromScript(`
        <script>
          fbq('init', '1234567890');
          fbq("init", "9876543210");
        </script>
        <noscript><img src="https://www.facebook.com/tr?id=1234567890&ev=PageView" /></noscript>
      `),
    ).toEqual(["1234567890", "9876543210"]);
  });

  it("does not treat noscript image URLs as browser Pixel initialization", () => {
    expect(
      extractFacebookPixelIdsFromScript(
        '<noscript><img src="https://www.facebook.com/tr?id=1234567890&ev=PageView" /></noscript>',
      ),
    ).toEqual([]);
  });

  it("ignores placeholder Pixel IDs", () => {
    expect(
      extractFacebookPixelIdsFromScript("fbq('init', 'PIXEL_ID');"),
    ).toEqual([]);
  });

  it("reports a matched single browser Pixel as ok", () => {
    expect(
      buildMetaPixelParityDiagnostics("1234567890", [
        { type: "facebook_pixel", config: "fbq('init', '1234567890');" },
      ]),
    ).toMatchObject({
      status: "ok",
      severity: "success",
      activeBrowserPixelIds: ["1234567890"],
    });
  });

  it("warns when the CAPI Pixel ID does not match active browser Pixels", () => {
    expect(
      buildMetaPixelParityDiagnostics("1234567890", [
        { type: "facebook_pixel", config: "fbq('init', '9876543210');" },
      ]),
    ).toMatchObject({
      status: "mismatch",
      severity: "warning",
      activeBrowserPixelIds: ["9876543210"],
    });
  });

  it("warns when an active Facebook Pixel script has no readable ID", () => {
    expect(
      buildMetaPixelParityDiagnostics("1234567890", [
        {
          type: "facebook_pixel",
          config: "window.fbq && fbq('track', 'PageView');",
        },
      ]),
    ).toMatchObject({
      status: "unreadable_browser_pixel",
      activeFacebookPixelScriptCount: 1,
      parseableFacebookPixelScriptCount: 0,
    });
  });

  it("counts custom snippets only when they include a readable fbq init", () => {
    expect(
      buildMetaPixelParityDiagnostics("1234567890", [
        {
          type: "google_analytics",
          config: "<script>gtag('config', 'G-1')</script>",
        },
        { type: "custom", config: "fbq('init', '1234567890');" },
      ]),
    ).toMatchObject({
      status: "ok",
      activeFacebookPixelScriptCount: 1,
      activeBrowserPixelIds: ["1234567890"],
    });
  });
});
