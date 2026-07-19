export const analyticsScriptTypes = [
  "google_analytics",
  "google_tag_manager",
  "facebook_pixel",
  "tiktok_pixel",
  "cloudflare_web_analytics",
  "custom",
] as const;

export type AnalyticsScriptType = (typeof analyticsScriptTypes)[number];
