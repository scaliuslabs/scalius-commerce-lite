import { describe, expect, it } from "vitest";
import {
  ANALYTICS_PROVIDER_MARKS,
  analyticsReadinessPresentation,
} from "./analytics-list-presentation";

describe("analytics list readiness presentation", () => {
  it.each([
    ["ready", "Live", "dark:text-emerald-300"],
    ["ready_to_activate", "Ready to activate", "dark:text-sky-300"],
    ["draft", "Draft", "dark:text-amber-300"],
    ["blocked", "Needs attention", "text-destructive"],
    ["trashed", "In trash", "text-muted-foreground"],
  ] as const)("presents %s truthfully in light and dark modes", (readiness, label, className) => {
    expect(analyticsReadinessPresentation(readiness)).toMatchObject({
      label,
      className: expect.stringContaining(className),
    });
  });

  it("maps every first-class analytics provider to its reviewed local mark", () => {
    expect(ANALYTICS_PROVIDER_MARKS).toEqual({
      google_analytics: "google-analytics",
      google_tag_manager: "google-tag-manager",
      facebook_pixel: "meta",
      tiktok_pixel: "tiktok",
      cloudflare_web_analytics: "cloudflare",
    });
  });
});
