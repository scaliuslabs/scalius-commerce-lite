import {
  analyticsScriptTypes,
  type AnalyticsScriptType,
} from "../../lib/analytics-script-types";

export const DEFAULT_ANALYTICS_CREATE_TYPE: AnalyticsScriptType =
  "cloudflare_web_analytics";

export function normalizeAnalyticsCreateType(value: unknown): AnalyticsScriptType {
  return analyticsScriptTypes.includes(value as AnalyticsScriptType)
    ? (value as AnalyticsScriptType)
    : DEFAULT_ANALYTICS_CREATE_TYPE;
}

export function buildAnalyticsCreateSearch(
  type: AnalyticsScriptType,
): { type?: AnalyticsScriptType } {
  return type === DEFAULT_ANALYTICS_CREATE_TYPE ? {} : { type };
}

export function buildAnalyticsCreateSearchString(type: AnalyticsScriptType): string {
  return type === DEFAULT_ANALYTICS_CREATE_TYPE ? "" : `?type=${type}`;
}

export function buildAnalyticsCreateHref(type: AnalyticsScriptType): string {
  return `/admin/analytics/new${buildAnalyticsCreateSearchString(type)}`;
}

export function getAnalyticsCreateTypeFromHref(href: string): AnalyticsScriptType {
  const queryStart = href.indexOf("?");
  if (queryStart === -1) return DEFAULT_ANALYTICS_CREATE_TYPE;
  const hashStart = href.indexOf("#", queryStart);
  const search = href.slice(queryStart + 1, hashStart === -1 ? undefined : hashStart);
  return normalizeAnalyticsCreateType(new URLSearchParams(search).get("type"));
}

export function selectAnalyticsCreateType(
  type: AnalyticsScriptType,
  onFormTypeChange: (type: AnalyticsScriptType) => void,
  onRouteTypeChange?: (type: AnalyticsScriptType) => void,
) {
  if (onRouteTypeChange) {
    onRouteTypeChange(type);
    return;
  }
  onFormTypeChange(type);
}
