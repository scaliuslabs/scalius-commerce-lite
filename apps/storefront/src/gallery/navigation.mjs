/** Local gallery navigation only: context is a public case id, never a cookie or last-visited global. */
export const ENTRY_QUERY = "__gallery_entry";

export function cleanGalleryUrl(value) {
  const url = new URL(value);
  url.searchParams.delete(ENTRY_QUERY);
  return url;
}

export function galleryContextId(url, referer, hasEntry) {
  const valid = (id) => typeof id === "string" && /^[a-z0-9-]{1,240}$/.test(id) && hasEntry(id) ? id : null;
  const fromUrl = (candidate) => {
    if (candidate.searchParams.has(ENTRY_QUERY)) {
      return candidate.searchParams.getAll(ENTRY_QUERY).length === 1 ? valid(candidate.searchParams.get(ENTRY_QUERY)) : null;
    }
    const match = /^\/__gallery\/e\/([^/]+)$/.exec(candidate.pathname);
    return match ? valid(match[1]) : null;
  };
  if (url.searchParams.has(ENTRY_QUERY) || url.pathname.startsWith("/__gallery/e/")) return fromUrl(url);
  try {
    const source = new URL(referer);
    return source.origin === url.origin ? fromUrl(source) : null;
  } catch { return null; }
}

export function galleryNavigationRedirect(url, entryId, headers, page) {
  const destination = headers["sec-fetch-dest"];
  const document = destination ? destination === "document" || destination === "iframe" : String(headers.accept ?? "").includes("text/html");
  if (!page || !document || !entryId || url.searchParams.has(ENTRY_QUERY)) return null;
  const target = new URL(url);
  target.searchParams.set(ENTRY_QUERY, entryId);
  return `${target.pathname}${target.search}`;
}

/** Catalog load-more replaces the URL with a production href; retain this tab's fixture id only. */
export function galleryHistoryScript(entryId) {
  if (!/^[a-z0-9-]{1,240}$/.test(entryId)) throw new Error("Invalid gallery entry");
  return `<script data-gallery-context>(function(){const id=${JSON.stringify(entryId)};for(const method of ["pushState","replaceState"]){const original=history[method];history[method]=function(state,title,href){if(href!=null){const next=new URL(href,location.href);if(next.origin===location.origin&&!next.pathname.startsWith("/__gallery/")){next.searchParams.set("__gallery_entry",id);href=next.href;}}return original.call(this,state,title,href);};}})();</script>`;
}
