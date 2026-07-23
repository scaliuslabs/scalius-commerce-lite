import { describe, expect, it } from "vitest";
import {
  buildAnalyticsCreateSearch,
  buildAnalyticsCreateHref,
  buildAnalyticsCreateSearchString,
  DEFAULT_ANALYTICS_CREATE_TYPE,
  normalizeAnalyticsCreateType,
  selectAnalyticsCreateType,
  getAnalyticsCreateTypeFromHref,
  getAnalyticsProviderDeliveryDefaults,
  readAnalyticsSaveIdentity,
} from "./analytics-create-route-state";

describe("analytics creation route state", () => {
  it("normalizes missing and invalid provider types to the canonical default", () => {
    expect(normalizeAnalyticsCreateType(undefined)).toBe(
      DEFAULT_ANALYTICS_CREATE_TYPE,
    );
    expect(normalizeAnalyticsCreateType("unknown_provider")).toBe(
      DEFAULT_ANALYTICS_CREATE_TYPE,
    );
  });

  it("preserves every supported provider type", () => {
    for (const type of [
      "cloudflare_web_analytics",
      "google_analytics",
      "google_tag_manager",
      "facebook_pixel",
      "tiktok_pixel",
      "custom",
    ] as const) {
      expect(normalizeAnalyticsCreateType(type)).toBe(type);
    }
  });

  it("restores provider-appropriate delivery defaults when the type changes", () => {
    expect(
      getAnalyticsProviderDeliveryDefaults("cloudflare_web_analytics"),
    ).toEqual({ location: "body_end", usePartytown: false });
    expect(getAnalyticsProviderDeliveryDefaults("facebook_pixel")).toEqual({
      location: "head",
      usePartytown: true,
    });
    expect(getAnalyticsProviderDeliveryDefaults("custom")).toEqual({
      location: "head",
      usePartytown: true,
    });
  });

  it("reads revision authority from create and update responses", () => {
    expect(readAnalyticsSaveIdentity({ id: "analytics_1", revision: 3 })).toEqual({
      id: "analytics_1",
      revision: 3,
    });
    expect(
      readAnalyticsSaveIdentity({
        script: { id: "analytics_2", revision: 8 },
      }),
    ).toEqual({ id: "analytics_2", revision: 8 });
    expect(readAnalyticsSaveIdentity({ script: null })).toBeNull();
  });

  it("omits the canonical default and serializes only non-default provider state", () => {
    expect(buildAnalyticsCreateSearch("cloudflare_web_analytics")).toEqual({});
    expect(buildAnalyticsCreateSearch("google_analytics")).toEqual({
      type: "google_analytics",
    });
    expect(buildAnalyticsCreateSearchString("cloudflare_web_analytics")).toBe("");
    expect(buildAnalyticsCreateSearchString("google_analytics")).toBe(
      "?type=google_analytics",
    );
    expect(buildAnalyticsCreateHref("cloudflare_web_analytics")).toBe(
      "/admin/analytics/new",
    );
    expect(buildAnalyticsCreateHref("google_analytics")).toBe(
      "/admin/analytics/new?type=google_analytics",
    );
  });

  it("lets the route own provider changes without briefly diverging form state", () => {
    const formChanges: string[] = [];
    const routeChanges: string[] = [];

    selectAnalyticsCreateType(
      "google_tag_manager",
      (type) => formChanges.push(type),
      (type) => routeChanges.push(type),
    );

    expect(routeChanges).toEqual(["google_tag_manager"]);
    expect(formChanges).toEqual([]);
  });

  it("derives canonicalization from the destination href instead of stale form state", () => {
    expect(getAnalyticsCreateTypeFromHref("/admin/analytics/new")).toBe(
      "cloudflare_web_analytics",
    );
    expect(
      getAnalyticsCreateTypeFromHref(
        "/admin/analytics/new?type=google_tag_manager&unknown=value",
      ),
    ).toBe("google_tag_manager");
    expect(getAnalyticsCreateTypeFromHref("/admin/analytics/new?type=bogus")).toBe(
      "cloudflare_web_analytics",
    );
  });

  it("updates the form directly when an edit page has no route-state owner", () => {
    const formChanges: string[] = [];

    selectAnalyticsCreateType("custom", (type) => formChanges.push(type));

    expect(formChanges).toEqual(["custom"]);
  });
});
