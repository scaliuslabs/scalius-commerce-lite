import {
  analyticsScriptTypes,
  type AnalyticsScriptType,
} from "../../lib/analytics-script-types";

export const DEFAULT_ANALYTICS_CREATE_TYPE: AnalyticsScriptType =
  "cloudflare_web_analytics";

export function getAnalyticsProviderDeliveryDefaults(
  type: AnalyticsScriptType,
): { location: "head" | "body_end"; usePartytown: boolean } {
  return type === "cloudflare_web_analytics"
    ? { location: "body_end", usePartytown: false }
    : { location: "head", usePartytown: true };
}

export function readAnalyticsSaveIdentity(
  result: unknown,
): { id: string; revision: number } | null {
  if (!result || typeof result !== "object") return null;
  const payload = result as {
    id?: unknown;
    revision?: unknown;
    script?: { id?: unknown; revision?: unknown } | null;
  };
  const id = payload.script?.id ?? payload.id;
  const revision = payload.script?.revision ?? payload.revision;
  return typeof id === "string" && id.length > 0 &&
      typeof revision === "number" && Number.isInteger(revision) && revision > 0
    ? { id, revision }
    : null;
}

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
