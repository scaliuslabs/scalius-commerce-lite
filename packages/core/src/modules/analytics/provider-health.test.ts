import { describe, expect, it } from "vitest";

import {
  buildAnalyticsProviderHealth,
  buildMetaCapiServerSideReadiness,
} from "./provider-health";

const VALID_GA4_CONFIG = `
<script async src="https://www.googletagmanager.com/gtag/js?id=G-ABC123DEF4"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', 'G-ABC123DEF4');
</script>`;

const VALID_FACEBOOK_PIXEL_CONFIG = `
<script>
  fbq('init', '123456789012345');
  fbq('track', 'PageView');
</script>`;

describe("analytics provider health", () => {
  it("summarizes active ready snippets, inactive drafts, and invalid active legacy rows", () => {
    const health = buildAnalyticsProviderHealth([
      {
        type: "google_analytics",
        config: VALID_GA4_CONFIG,
        isActive: true,
      },
      {
        type: "tiktok_pixel",
        config: "<script>ttq.load('PIXEL_ID');ttq.page();</script>",
        isActive: false,
      },
      {
        type: "facebook_pixel",
        config: "<script>fbq('init', 'PIXEL_ID');</script>",
        isActive: true,
      },
    ]);

    expect(health.summary).toMatchObject({
      totalProviders: 6,
      browserReadyProviders: 1,
      draftProviders: 1,
      blockedProviders: 1,
    });

    expect(
      health.providers.find((provider) => provider.provider === "google_analytics"),
    ).toMatchObject({
      browser: {
        status: "ready",
        configured: true,
        readyScriptCount: 1,
      },
      serverSide: {
        status: "not_configured",
        label: "Browser only",
      },
    });

    expect(
      health.providers.find((provider) => provider.provider === "tiktok_pixel"),
    ).toMatchObject({
      browser: {
        status: "draft",
        draftScriptCount: 1,
      },
      serverSide: {
        status: "not_configured",
        label: "Browser only",
      },
    });

    const facebook = health.providers.find(
      (provider) => provider.provider === "facebook_pixel",
    );

    expect(facebook).toMatchObject({
      browser: {
        status: "blocked",
        blockedScriptCount: 1,
        configured: false,
      },
    });
    expect(facebook?.browser.issues[0]).toContain("placeholder");
    expect(JSON.stringify(health)).not.toContain("PIXEL_ID");
    expect(JSON.stringify(health)).not.toContain("G-ABC123DEF4");
  });

  it("marks active invalid Cloudflare Web Analytics legacy snippets as blocked", () => {
    const health = buildAnalyticsProviderHealth([
      {
        type: "cloudflare_web_analytics",
        config: '<script src="https://example.com/beacon.js"></script>',
        isActive: true,
      },
    ]);

    const cloudflare = health.providers.find(
      (provider) => provider.provider === "cloudflare_web_analytics",
    );

    expect(cloudflare).toMatchObject({
      browser: {
        status: "blocked",
        blockedScriptCount: 1,
      },
    });
    expect(cloudflare?.browser.issues[0]).toContain(
      "Cloudflare Web Analytics",
    );
  });

  it("includes safe Meta CAPI server-side readiness without returning credentials", async () => {
    const metaServerSide = await buildMetaCapiServerSideReadiness({
      pixelId: "123456789012345",
      accessToken: "meta-access-token",
      isEnabled: true,
    });

    const health = buildAnalyticsProviderHealth(
      [
        {
          type: "facebook_pixel",
          config: VALID_FACEBOOK_PIXEL_CONFIG,
          isActive: true,
        },
      ],
      { metaServerSide },
    );

    const facebook = health.providers.find(
      (provider) => provider.provider === "facebook_pixel",
    );

    expect(facebook).toMatchObject({
      browser: {
        status: "ready",
        configured: true,
      },
      serverSide: {
        status: "ready",
        configured: true,
        label: "Server ready",
      },
    });
    expect(JSON.stringify(health)).not.toContain("meta-access-token");
  });

  it("blocks enabled Meta CAPI when an encrypted token cannot be read", async () => {
    const readiness = await buildMetaCapiServerSideReadiness({
      pixelId: "123456789012345",
      accessToken: "enc:AAAAAAAAAAAAAAAA:BBBBBBBBBBBBBBBBBBBBBBBB",
      isEnabled: true,
    });

    expect(readiness).toMatchObject({
      status: "blocked",
      configured: false,
      label: "Server blocked",
    });
    expect(readiness.message).toContain("access token cannot be read");
  });
});
