/**
 * Server-side policy helpers for public analytics script injection.
 * Browser event dispatch is owned by the storefront application.
 */

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
 * Adds the Partytown script type while preserving the remaining attributes.
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
 * Known marketing providers remain isolated even when legacy rows predate the
 * current policy; only custom code may opt in or out.
 */
export function shouldUsePartytown(script: AnalyticsConfig): boolean {
  return resolveAnalyticsPartytownPolicy(script);
}

export function shouldInjectAnalyticsScript(script: AnalyticsConfig): boolean {
  return isPubliclyInjectableAnalyticsConfig(script);
}
