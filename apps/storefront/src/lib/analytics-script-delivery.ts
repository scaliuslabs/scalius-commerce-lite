import type { AnalyticsConfig } from "@/lib/api";
import { analyticsScriptConsentCategory } from "@scalius/shared/tracking-consent";

const SCRIPT_OPEN = /<script\b([^>]*)>/gi;
const TYPE_ATTRIBUTE = /\stype\s*=\s*(["'])(.*?)\1/i;
const NOSCRIPT = /<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi;

/**
 * A Meta or TikTok snippet (or a custom one that loads either) needs
 * marketing consent (audit spec §3.10). Its scripts are rendered inert
 * (`type="text/plain"`, the real type kept in `data-scalius-type`) for the
 * consent runtime to start once marketing is granted, and its <noscript>
 * pixel goes: without JavaScript nobody can consent. Other scripts pass
 * unchanged; Google tags load under Consent Mode defaults.
 */
/** A Google tag (GA4 or Tag Manager): it loads under Consent Mode v2 defaults. */
export function isGoogleTagScript(script: Pick<AnalyticsConfig, "type" | "config">): boolean {
  const type = script.type.trim().toLowerCase();
  return type === "google_analytics"
    || type === "google_tag_manager"
    || (type === "custom" && /googletagmanager\.com|\bgtag\s*\(/i.test(script.config));
}

/** Whether a script makes the page need the consent banner. */
export function scriptNeedsConsent(script: Pick<AnalyticsConfig, "type" | "config">): boolean {
  return analyticsScriptConsentCategory(script) === "marketing" || isGoogleTagScript(script);
}

export function gateMarketingScript(script: AnalyticsConfig): AnalyticsConfig {
  if (analyticsScriptConsentCategory(script) !== "marketing") return script;
  const config = script.config.replace(NOSCRIPT, "").replace(SCRIPT_OPEN, (_tag, attributes: string) => {
    const type = TYPE_ATTRIBUTE.exec(attributes)?.[2] ?? "";
    if (/^application\/(?:ld\+)?json$/i.test(type)) return `<script${attributes}>`;
    const rest = attributes.replace(TYPE_ATTRIBUTE, "");
    return `<script type="text/plain" data-scalius-consent="marketing" data-scalius-type="${type.replace(/"/g, "")}"${rest}>`;
  });
  return { ...script, config };
}

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
