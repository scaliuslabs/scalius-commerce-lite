/**
 * Catalog handles (product, category and brand slugs) are lowercase only
 * (`^[a-z0-9]+(?:-[a-z0-9]+)*$`), so `/products/Aster-Clogs` can only mean
 * `/products/aster-clogs`: a permanent redirect keeps shared, typed or
 * mis-cased links working and gives search engines one URL. The query string
 * (a `?variant=` id is case-sensitive) is kept as it is.
 */
export function lowercaseHandleRedirect(url: URL): Response | null {
  const lower = url.pathname.toLowerCase();
  if (lower === url.pathname) return null;
  return new Response(null, {
    status: 301,
    headers: { Location: `${lower}${url.search}` },
  });
}
