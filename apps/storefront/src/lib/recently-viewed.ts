/**
 * Recently viewed products (Amazon's browsing history, Apple Gadgets'
 * "Recently viewed"): a per-browser list, never part of a cached page.
 * Product pages record each view in localStorage; the homepage island draws
 * the list from it before it paints. Only the product's id, handle, name and
 * card photo are kept: no price (it would go stale), nothing about the buyer.
 * After the first paint the row is checked against the public catalogue
 * (recently-viewed-client.ts), and products that are no longer public are
 * dropped from the row and from storage.
 */
import { serializeJsonForInlineScript } from "@/lib/safe-json";
import { serverPagePath } from "@/lib/server-presence";

export const RECENTLY_VIEWED_STORAGE_KEY = "scalius:recently-viewed:v2";
/** Most products kept and shown (Amazon shows a rail of about a dozen). */
export const RECENTLY_VIEWED_LIMIT = 12;

export interface RecentlyViewedEntry {
  /** The product id: the only identifier sent to the API when the row is checked. */
  id: string;
  slug: string;
  name: string;
  /** A card-sized photo URL (https or same-origin path), or null. */
  image: string | null;
}

/** The inline script a product page runs to record its view (the newest first, each product once). */
export function recentlyViewedRecordScript(entry: RecentlyViewedEntry): string {
  return `(function(){try{var k=${serializeJsonForInlineScript(RECENTLY_VIEWED_STORAGE_KEY)},e=${serializeJsonForInlineScript(entry)},s=localStorage,l=JSON.parse(s.getItem(k)||"[]");if(!Array.isArray(l))l=[];l=l.filter(function(x){return x&&typeof x.id==="string"&&x.id!==e.id});l.unshift(e);s.setItem(k,JSON.stringify(l.slice(0,${RECENTLY_VIEWED_LIMIT})))}catch(_){}})();`;
}

/**
 * The inline script that fills a recently-viewed island (`root`'s id) from
 * this browser's list, then shows it. It runs as the parser reaches it,
 * before the section paints, so filling it shifts nothing; with no list, or
 * storage blocked, the section stays hidden. Entries are drawn with DOM
 * text and attributes only, and only safe handles and image URLs are used.
 * Each row item carries its product id (`data-recently-viewed-id`) so the
 * later check can remove it. A product page leaves its own product out
 * (`excludeSlug`).
 */
export function recentlyViewedRenderScript(rootId: string, excludeSlug: string | null = null): string {
  return `(function(){try{var r=document.getElementById(${serializeJsonForInlineScript(rootId)});if(!r)return;var l=JSON.parse(localStorage.getItem(${serializeJsonForInlineScript(RECENTLY_VIEWED_STORAGE_KEY)})||"[]");if(!Array.isArray(l))return;var u=r.querySelector("[data-recently-viewed-list]"),n=0,o=${serializeJsonForInlineScript(excludeSlug)};l.filter(function(x){return !x||x.slug!==o}).slice(0,${RECENTLY_VIEWED_LIMIT}).forEach(function(x){if(!x||typeof x.id!=="string"||!x.id||x.id.length>100||typeof x.slug!=="string"||!x.slug||x.slug.length>200||typeof x.name!=="string"||!x.name.trim())return;var li=document.createElement("li");li.setAttribute("data-recently-viewed-id",x.id);li.className="w-28 shrink-0 snap-start sm:w-36 lg:w-40";var a=document.createElement("a");a.href=${serializeJsonForInlineScript(serverPagePath("/products/"))}+encodeURIComponent(x.slug);a.className="group block";var f=document.createElement("div");f.className="aspect-square overflow-hidden rounded-lg bg-muted";if(typeof x.image==="string"&&/^(https:\\/\\/|\\/(?!\\/))/.test(x.image)){var i=document.createElement("img");i.src=x.image;i.alt="";i.loading="lazy";i.decoding="async";i.width=320;i.height=320;i.className="h-full w-full object-cover";f.appendChild(i)}var p=document.createElement("p");p.className="mt-2 line-clamp-2 text-sm text-foreground group-hover:underline";p.textContent=x.name.trim();a.appendChild(f);a.appendChild(p);li.appendChild(a);u.appendChild(li);n++});if(n>0)r.hidden=false}catch(_){}})();`;
}

/** Ids sent to the API to check the row: the kept products' ids only, at most the list limit. */
export function recentlyViewedIds(entries: readonly unknown[]): string[] {
  const ids: string[] = [];
  for (const entry of entries) {
    const id = entry && typeof entry === "object" ? (entry as { id?: unknown }).id : undefined;
    if (typeof id === "string" && id && id.length <= 100 && !ids.includes(id)) ids.push(id);
    if (ids.length >= RECENTLY_VIEWED_LIMIT) break;
  }
  return ids;
}

/** The checked ids the public catalogue did not return: products deleted, unpublished or in draft. */
export function recentlyViewedGoneIds(requested: readonly string[], publicIds: ReadonlySet<string>): Set<string> {
  return new Set(requested.filter((id) => !publicIds.has(id)));
}

/**
 * Removes gone products from this browser's list. It re-reads storage so a
 * view recorded meanwhile survives, and writes only when something changed.
 * Returns whether storage was written; storage errors are swallowed (the list
 * is a convenience).
 */
export function pruneStoredRecentlyViewed(
  storage: Pick<Storage, "getItem" | "setItem">,
  goneIds: ReadonlySet<string>,
): boolean {
  if (goneIds.size === 0) return false;
  try {
    const list: unknown = JSON.parse(storage.getItem(RECENTLY_VIEWED_STORAGE_KEY) || "[]");
    if (!Array.isArray(list)) return false;
    const kept = list.filter((entry) => !(entry && typeof entry.id === "string" && goneIds.has(entry.id)));
    if (kept.length === list.length) return false;
    storage.setItem(RECENTLY_VIEWED_STORAGE_KEY, JSON.stringify(kept));
    return true;
  } catch {
    return false;
  }
}
