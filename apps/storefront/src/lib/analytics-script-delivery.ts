import type { AnalyticsConfig } from "@/lib/api";

const CLOUDFLARE_MODULE_PREFIX =
  '<script type="module" src="https://static.cloudflareinsights.com/beacon.min.js"';

/**
 * RUM is observational rather than render-critical. Keep Cloudflare's current
 * module snippet intact while explicitly placing its fetch below buyer images.
 */
export function optimizeAnalyticsScriptDelivery(
  script: AnalyticsConfig,
): AnalyticsConfig {
  if (
    script.type.trim().toLowerCase() !== "cloudflare_web_analytics" ||
    !script.config.includes(CLOUDFLARE_MODULE_PREFIX) ||
    /\bfetchpriority\s*=/i.test(script.config)
  ) {
    return script;
  }

  return {
    ...script,
    config: script.config.replace(
      '<script type="module"',
      '<script type="module" fetchpriority="low"',
    ),
  };
}
