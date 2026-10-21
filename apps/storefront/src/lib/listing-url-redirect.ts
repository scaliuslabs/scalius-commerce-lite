/**
 * The redirects a catalog page decides from its URL alone, before any read:
 * a mis-cased handle, a search scope, and a listing query that is not in its
 * clean form (empty or malformed filters, defaults spelled out, repeated
 * singletons, a parameter that can never be a filter).
 *
 * The middleware asks this before it starts the layout read, so such a URL
 * (crawler junk, a stale link) costs no API batch: before, the layout read had
 * already joined the render's batch when the page returned its redirect.
 * The pages run the same checks in the same order (they stay the authority
 * for a presence render, whose middleware keeps its presence 404 check), so
 * the answer is the one the page would give. Redirects that need the
 * listing's facets (an unknown facet value) are still decided by the page.
 */
import { lowercaseHandleRedirect } from "@/lib/lowercase-route";
import { resolveProductListQueryState } from "@/lib/product-list-query";
import { searchScopeRedirect } from "@/lib/search-query";

/** What `Astro.redirect(path)` answers: a 302 to the path. */
function found(location: string): Response {
  return new Response(null, { status: 302, headers: { Location: location } });
}

function listingQueryRedirect(url: URL, rankByRelevance = false): Response | null {
  const state = resolveProductListQueryState({ url, allowUnknownAttributes: true, rankByRelevance });
  return state.redirectPath ? found(state.redirectPath) : null;
}

/**
 * The redirect the page at `routePattern` (Astro's route, `/categories/[slug]`)
 * would answer for `url` before its first read, or null when the page must
 * render (or decide after its reads).
 */
export function catalogRedirectBeforeReads(routePattern: string, url: URL): Response | null {
  switch (routePattern) {
    case "/products/[slug]":
      return lowercaseHandleRedirect(url);
    case "/categories/[slug]":
    case "/brands/[slug]": {
      const lowercase = lowercaseHandleRedirect(url);
      if (lowercase) return lowercase;
      // A route without a handle answers 404 from the page.
      if (!url.pathname.split("/")[2]) return null;
      return listingQueryRedirect(url);
    }
    case "/collections/[id]":
      return listingQueryRedirect(url);
    case "/search": {
      const scope = searchScopeRedirect(url);
      if (scope) return found(scope);
      return listingQueryRedirect(url, true);
    }
    default:
      return null;
  }
}
