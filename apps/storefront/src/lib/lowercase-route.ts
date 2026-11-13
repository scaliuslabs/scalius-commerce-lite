import { canonicalRedirect } from "@/lib/canonical-redirect";

/**
 * Catalog handles (product, category and brand slugs) are lowercase ASCII only
 * (`^[a-z0-9]+(?:-[a-z0-9]+)*$`), so `/products/Aster-Clogs` can only mean
 * `/products/aster-clogs`: a permanent redirect keeps shared, typed or
 * mis-cased links working and gives search engines one URL. The query string
 * (a `?variant=` id is case-sensitive) is kept as it is.
 *
 * Only ASCII capitals change, written or escaped (`%41` is `A`). A
 * percent-escape is never re-cased (its hex case is not the letter's case,
 * and the runtime may re-spell it on the next hop), and a non-ASCII path
 * (`/categories/লাল`, `/products/Москва`) is left to the page, which answers
 * 404 because no handle is spelled that way.
 */
export function lowercaseHandlePath(pathname: string): string {
  return pathname.replace(/%([0-9a-fA-F]{2})|[A-Z]/g, (match, hex: string | undefined) => {
    if (!hex) return match.toLowerCase();
    const code = Number.parseInt(hex, 16);
    return code >= 0x41 && code <= 0x5a ? String.fromCharCode(code + 0x20) : match;
  });
}

/**
 * The catalog routes, by their first segment, and whether their handles are
 * lowercase-only. A collection is named by its id, which keeps its case, so
 * only its route segment is lowercased. Every other path (the API, assets,
 * a recovery or receipt token, an account or warranty page, a preview, an
 * app's page) is case-sensitive on purpose and left as it is.
 */
const CATALOG_ROUTES: Readonly<Record<string, boolean>> = { products: true, categories: true, brands: true, pages: true, collections: false };

/** The path a mis-cased catalog URL means (`/Products/Tee` is `/products/tee`); any other path unchanged. */
export function catalogCasePath(pathname: string): string {
  const match = /^\/([^/]+)(\/.*)?$/.exec(pathname);
  if (!match) return pathname;
  const route = lowercaseHandlePath(match[1]!);
  if (!Object.hasOwn(CATALOG_ROUTES, route)) return pathname;
  const rest = match[2] ?? "";
  return `/${route}${CATALOG_ROUTES[route] ? lowercaseHandlePath(rest) : rest}`;
}

/** The one permanent redirect of a mis-cased catalog URL, asked before route matching decides anything. */
export function lowercaseHandleRedirect(url: URL): Response | null {
  const lower = catalogCasePath(url.pathname);
  if (lower === url.pathname) return null;
  return canonicalRedirect(url, `${lower}${url.search}`, 301);
}
