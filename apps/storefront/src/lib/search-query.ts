import { STOREFRONT_SEARCH_SCOPE_PARAM } from "@scalius/shared/storefront-routes";

export function normalizeSearchQuery(value: string | null | undefined): string {
  return (value ?? "").trim().replace(/\s+/g, " ");
}

/** A category handle as URLs carry it (lowercase; see `lowercaseHandleRedirect`). */
const CATEGORY_HANDLE = /^[a-z0-9\u0080-￿][a-z0-9\u0080-￿_-]{0,199}$/;

/**
 * Where a scoped search goes (`/search?q=…&category=<handle>`): the
 * category's listing with the query, or the plain search without an empty
 * or unusable scope. Null when the URL names no scope.
 */
export function searchScopeRedirect(url: URL): string | null {
  if (!url.searchParams.has(STOREFRONT_SEARCH_SCOPE_PARAM)) return null;
  const handle = url.searchParams.getAll(STOREFRONT_SEARCH_SCOPE_PARAM).at(-1)?.trim().toLowerCase() ?? "";
  const query = normalizeSearchQuery(url.searchParams.get("q"));
  const search = query ? `?${new URLSearchParams({ q: query })}` : "";
  if (handle && CATEGORY_HANDLE.test(handle)) return `/categories/${encodeURIComponent(handle)}${search}`;
  const rest = new URLSearchParams(url.searchParams);
  rest.delete(STOREFRONT_SEARCH_SCOPE_PARAM);
  const remaining = rest.toString();
  return `${url.pathname}${remaining ? `?${remaining}` : ""}`;
}
