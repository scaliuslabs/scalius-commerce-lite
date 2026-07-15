import {
  parseNavigationQuery,
  type NavigationTargetItem,
} from "@scalius/shared/navigation-target";

import type { NavigationSource } from "./types";

interface CreateResourceNavigationItemOptions {
  id: string;
  customLabel?: string;
  query?: string;
}

/**
 * Create an optimistic admin projection for a resource selected from the
 * public resource picker. The stable resource ID remains the stored authority;
 * `resolution` is deliberately stripped by the server before persistence and
 * recomputed from D1 on the next read.
 */
export function createResourceNavigationItem(
  source: NavigationSource,
  options: CreateResourceNavigationItemOptions,
): NavigationTargetItem {
  const customLabel = options.customLabel?.trim();
  const query = parseNavigationQuery(options.query);
  const normalizedQuery = query.ok ? query.query : undefined;
  const title = customLabel || source.name;

  return {
    id: options.id,
    target: {
      type: "resource",
      resourceType: source.type,
      resourceId: source.id,
      ...(normalizedQuery ? { query: normalizedQuery } : {}),
    },
    labelMode: customLabel ? "custom" : "resource",
    ...(customLabel ? { customLabel } : {}),
    lastKnownLabel: source.name,
    subMenu: [],
    resolution: {
      title,
      href: `${source.url}${normalizedQuery ?? ""}`,
      readiness: "ready",
      available: true,
    },
  };
}
