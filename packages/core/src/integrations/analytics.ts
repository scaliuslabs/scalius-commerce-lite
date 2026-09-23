// Server-side analytics script policy: snippet processing and public-injection
// checks. Browser event tracking lives in apps/storefront/src/lib/analytics.ts.

import {
  isPubliclyInjectableAnalyticsConfig,
  resolveAnalyticsPartytownPolicy,
} from "../modules/analytics/analytics.validation";

export interface AnalyticsConfig {
  type: string;
  config: string;
  isActive: boolean;
  usePartytown?: boolean;
}

/**
 * Processes an analytics script configuration to add Partytown attributes.
 * This function adds the type="text/partytown" attribute to script tags
 * to ensure they run in a web worker via Partytown.
 */
export function processAnalyticsScript(script: AnalyticsConfig): string {
  if (!script.config) return "";
  return script.config.replace(
    /<script\b([^>]*)>/gi,
    (_openingTag, attributes: string) => {
      const workerAttributes = attributes.replace(
        /\s+type\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi,
        "",
      );
      return `<script type="text/partytown"${workerAttributes}>`;
    },
  );
}

/**
 * Determines the effective delivery policy. Known marketing providers are
 * isolated even when a legacy row predates that invariant; only custom code
 * may opt in or out.
 */
export function shouldUsePartytown(script: AnalyticsConfig): boolean {
  return resolveAnalyticsPartytownPolicy(script);
}

export function shouldInjectAnalyticsScript(script: AnalyticsConfig): boolean {
  return isPubliclyInjectableAnalyticsConfig(script);
}
