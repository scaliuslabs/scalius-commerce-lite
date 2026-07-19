import { parseNavigationHref } from "./navigation-href";

export const NAVIGATION_RESOURCE_TYPES = [
  "page",
  "category",
  "collection",
  "product",
] as const;

export type NavigationResourceType = (typeof NAVIGATION_RESOURCE_TYPES)[number];
export type NavigationLabelMode = "resource" | "custom";

export type NavigationTarget =
  | {
      type: "resource";
      resourceType: NavigationResourceType;
      resourceId: string;
      query?: string;
    }
  | { type: "internal_path"; path: string }
  | { type: "external_url"; url: string }
  | { type: "label" };

export type NavigationReadiness =
  | "ready"
  | "resource_draft_or_internal"
  | "resource_trashed"
  | "resource_missing"
  | "invalid_custom_target"
  | "unverified_internal_path";

export interface NavigationResolution {
  title: string;
  href?: string;
  readiness: NavigationReadiness;
  available: boolean;
}

export interface NavigationTargetItem {
  id: string;
  target: NavigationTarget;
  labelMode: NavigationLabelMode;
  customLabel?: string;
  /** Diagnostic fallback only. It never wins over a live resource title. */
  lastKnownLabel?: string;
  openInNewTab?: boolean;
  subMenu?: NavigationTargetItem[];
  /** Read projection supplied by the central resolver; never persisted. */
  resolution?: NavigationResolution;
}

export interface ResolvedNavigationItem {
  id: string;
  title: string;
  href?: string;
  openInNewTab?: boolean;
  subMenu?: ResolvedNavigationItem[];
}

export type NavigationQueryParseResult =
  | { ok: true; query?: string }
  | { ok: false; reason: string };

const MAX_NAVIGATION_QUERY_LENGTH = 1_024;

/**
 * Resource queries are a projection on a stable resource target, never a path
 * authority. Only a query string is accepted; paths, fragments and protocols
 * are rejected.
 */
export function parseNavigationQuery(value: unknown): NavigationQueryParseResult {
  if (value == null) return { ok: true };
  if (typeof value !== "string") {
    return { ok: false, reason: "Navigation query must be text." };
  }

  const trimmed = value.trim();
  if (!trimmed || trimmed === "?") return { ok: true };
  if (trimmed.length > MAX_NAVIGATION_QUERY_LENGTH) {
    return {
      ok: false,
      reason: `Navigation query must be ${MAX_NAVIGATION_QUERY_LENGTH} characters or fewer.`,
    };
  }

  const query = trimmed.startsWith("?") ? trimmed.slice(1) : trimmed;
  if (
    query.includes("#") ||
    query.includes("\\") ||
    query.startsWith("/") ||
    /^[a-z][a-z0-9+.-]*:/i.test(query)
  ) {
    return { ok: false, reason: "Use query parameters only, without a path or fragment." };
  }
  for (const character of query) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) {
      return { ok: false, reason: "Navigation query cannot contain control characters." };
    }
  }

  try {
    const params = new URLSearchParams(query);
    return params.size > 0 ? { ok: true, query: `?${params.toString()}` } : { ok: true };
  } catch {
    return { ok: false, reason: "Navigation query is invalid." };
  }
}

export function getNavigationItemLabel(item: NavigationTargetItem): string {
  return (
    item.resolution?.title ??
    item.customLabel ??
    item.lastKnownLabel ??
    "Untitled item"
  ).trim() || "Untitled item";
}

export function getNavigationItemHref(item: NavigationTargetItem): string | undefined {
  if (item.resolution?.href) return item.resolution.href;
  if (item.target.type === "internal_path") {
    const parsed = parseNavigationHref(item.target.path);
    return parsed.ok && parsed.kind === "internal" ? parsed.href : undefined;
  }
  if (item.target.type === "external_url") {
    const parsed = parseNavigationHref(item.target.url);
    return parsed.ok && parsed.kind === "external" ? parsed.href : undefined;
  }
  return undefined;
}

export function stripNavigationResolution(
  item: NavigationTargetItem,
): NavigationTargetItem {
  const { resolution: _resolution, subMenu, ...stored } = item;
  return {
    ...stored,
    ...(subMenu?.length
      ? { subMenu: subMenu.map(stripNavigationResolution) }
      : {}),
  };
}
