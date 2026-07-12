import { describe, expect, it } from "vitest";

import { META_GRAPH_API_VERSION } from "../../integrations/meta/conversions-api";
import {
  CLOUDFLARE_WEB_ANALYTICS_SCRIPT_SRC,
  analyticsScriptTypes,
  createAnalyticsSchema,
  getAnalyticsProviderIdentifier,
  isPubliclyInjectableAnalyticsConfig,
  normalizeCloudflareWebAnalyticsConfig,
  updateAnalyticsSchema,
} from "./analytics.validation";
import {
  buildMetaPixelParityDiagnostics,
  extractFacebookPixelIdsFromScript,
} from "./meta-pixel-parity";

const VALID_GA4_CONFIG = `
<script async src="https://www.googletagmanager.com/gtag/js?id=G-ABC123DEF4"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', 'G-ABC123DEF4');
</script>`;

const VALID_GTM_CONFIG = `
<script>
  (function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':
  new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],
  j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src=
  'https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);
  })(window,document,'script','dataLayer','GTM-ABC1234');
</script>`;

const VALID_FACEBOOK_PIXEL_CONFIG = `
<script>
  fbq('init', '123456789012345');
  fbq('track', 'PageView');
</script>`;

const VALID_TIKTOK_PIXEL_CONFIG =
  "<script>ttq.load('C1234567890ABCDEFG');ttq.page();</script>";

describe("analytics validation", () => {
  it("creates analytics scripts as inactive drafts by default", () => {
    const result = createAnalyticsSchema.parse({
      name: "Draft custom script",
      type: "custom",
      usePartytown: true,
      config: "<script>window.demo = true;</script>",
      location: "head",
    });

    expect(result.isActive).toBe(false);
  });

  it("accepts Google Tag Manager as a first-class script type", () => {
    expect(analyticsScriptTypes).toContain("google_tag_manager");

    const result = createAnalyticsSchema.safeParse({
      name: "Google Tag Manager",
      type: "google_tag_manager",
      isActive: true,
      usePartytown: true,
      config: VALID_GTM_CONFIG,
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
      config: VALID_TIKTOK_PIXEL_CONFIG,
      location: "head",
    });

    expect(result.success).toBe(true);
  });

  it("accepts valid active first-class provider snippets on create and update", () => {
    const cases = [
      { type: "google_analytics", config: VALID_GA4_CONFIG },
      { type: "google_tag_manager", config: VALID_GTM_CONFIG },
      { type: "facebook_pixel", config: VALID_FACEBOOK_PIXEL_CONFIG },
      { type: "tiktok_pixel", config: VALID_TIKTOK_PIXEL_CONFIG },
    ] as const;

    for (const testCase of cases) {
      const createResult = createAnalyticsSchema.safeParse({
        name: "Analytics Script",
        type: testCase.type,
        isActive: true,
        usePartytown: true,
        config: testCase.config,
        location: "head",
      });
      const updateResult = updateAnalyticsSchema.safeParse({
        id: "analytics_1",
        expectedRevision: 1,
        name: "Analytics Script",
        type: testCase.type,
        isActive: true,
        usePartytown: true,
        config: testCase.config,
        location: "head",
      });

      expect(createResult.success, `${testCase.type} create`).toBe(true);
      expect(updateResult.success, `${testCase.type} update`).toBe(true);
    }
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

  it("rejects invalid or placeholder Cloudflare Web Analytics config", () => {
    const result = createAnalyticsSchema.safeParse({
      name: "Cloudflare Web Analytics",
      type: "cloudflare_web_analytics",
      isActive: true,
      usePartytown: false,
      config: '<script src="https://example.com/beacon.js"></script>',
      location: "body_end",
    });
    const placeholderToken = createAnalyticsSchema.safeParse({
      name: "Cloudflare Web Analytics",
      type: "cloudflare_web_analytics",
      isActive: true,
      usePartytown: false,
      config: "YOUR_CLOUDFLARE_WEB_ANALYTICS_TOKEN",
      location: "body_end",
    });
    const placeholderSnippet = createAnalyticsSchema.safeParse({
      name: "Cloudflare Web Analytics",
      type: "cloudflare_web_analytics",
      isActive: true,
      usePartytown: false,
      config: `<script defer src="${CLOUDFLARE_WEB_ANALYTICS_SCRIPT_SRC}" data-cf-beacon='{"token":"YOUR_CLOUDFLARE_WEB_ANALYTICS_TOKEN"}'></script>`,
      location: "body_end",
    });

    expect(result.success).toBe(false);
    expect(placeholderToken.success).toBe(false);
    expect(placeholderSnippet.success).toBe(false);
  });

  it("normalizes a Cloudflare Web Analytics token into the beacon snippet", () => {
    expect(normalizeCloudflareWebAnalyticsConfig("site_token_123")).toBe(
      `<script defer src="${CLOUDFLARE_WEB_ANALYTICS_SCRIPT_SRC}" data-cf-beacon='{"token":"site_token_123"}'></script>`,
    );
  });

  it("canonicalizes pasted Cloudflare Web Analytics beacon snippets", () => {
    expect(
      normalizeCloudflareWebAnalyticsConfig(`
        <script defer data-extra="ignored" src="${CLOUDFLARE_WEB_ANALYTICS_SCRIPT_SRC}" data-cf-beacon='{"token":"site_token_123"}'></script>
      `),
    ).toBe(
      `<script defer src="${CLOUDFLARE_WEB_ANALYTICS_SCRIPT_SRC}" data-cf-beacon='{"token":"site_token_123"}'></script>`,
    );
  });

  it("extracts safe list identifiers and masks Cloudflare site tokens", () => {
    expect(getAnalyticsProviderIdentifier("google_analytics", VALID_GA4_CONFIG)).toBe(
      "G-ABC123DEF4",
    );
    expect(getAnalyticsProviderIdentifier(
      "cloudflare_web_analytics",
      normalizeCloudflareWebAnalyticsConfig("site_token_123"),
    )).toBe("••••_123");
    expect(getAnalyticsProviderIdentifier("custom", "<script>secret()</script>")).toBeNull();
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
      {
        type: "cloudflare_web_analytics",
        config:
          "<script>window.analyticsToken = 'YOUR_CLOUDFLARE_WEB_ANALYTICS_TOKEN';</script>",
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

  it("rejects active provider snippets that do not match the selected type on create", () => {
    const cases = [
      {
        type: "google_analytics",
        config: VALID_GTM_CONFIG,
        message: "GA4 gtag.js",
      },
      {
        type: "google_tag_manager",
        config: VALID_GA4_CONFIG,
        message: "GTM-",
      },
      {
        type: "facebook_pixel",
        config: VALID_GA4_CONFIG,
        message: "fbq('init'",
      },
      {
        type: "tiktok_pixel",
        config: VALID_FACEBOOK_PIXEL_CONFIG,
        message: "ttq.load",
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
        expect(result.error.issues[0]?.message).toContain(testCase.message);
      }
    }
  });

  it("rejects active provider mismatches on update but keeps inactive drafts permissive", () => {
    const inactiveCreate = createAnalyticsSchema.safeParse({
      name: "Draft Analytics Script",
      type: "google_analytics",
      isActive: false,
      usePartytown: true,
      config: VALID_GTM_CONFIG,
      location: "head",
    });
    const inactiveUpdate = updateAnalyticsSchema.safeParse({
      id: "analytics_1",
      expectedRevision: 1,
      name: "Draft Analytics Script",
      type: "facebook_pixel",
      isActive: false,
      usePartytown: true,
      config: VALID_TIKTOK_PIXEL_CONFIG,
      location: "head",
    });
    const activeUpdate = updateAnalyticsSchema.safeParse({
      id: "analytics_1",
      expectedRevision: 1,
      name: "Draft Analytics Script",
      type: "tiktok_pixel",
      isActive: true,
      usePartytown: true,
      config: VALID_FACEBOOK_PIXEL_CONFIG,
      location: "head",
    });

    expect(inactiveCreate.success).toBe(true);
    expect(inactiveUpdate.success).toBe(true);
    expect(activeUpdate.success).toBe(false);
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
      expectedRevision: 1,
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

  it("marks legacy active provider mismatches as unsafe for public injection", () => {
    expect(
      isPubliclyInjectableAnalyticsConfig({
        type: "tiktok_pixel",
        isActive: true,
        config: VALID_GA4_CONFIG,
      }),
    ).toBe(false);
    expect(
      isPubliclyInjectableAnalyticsConfig({
        type: "custom",
        isActive: true,
        config: VALID_GA4_CONFIG,
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
