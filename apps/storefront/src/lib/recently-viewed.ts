/**
 * Recently viewed products (Amazon's browsing history, Apple Gadgets'
 * "Recently viewed"): a per-browser list, never sent anywhere and never part
 * of a cached page. Product pages record each view in localStorage; the
 * homepage island draws the list from it before it paints. Only the
 * product's handle, name and card photo are kept: no price (it would go
 * stale), nothing about the buyer.
 */
import { serializeJsonForInlineScript } from "@/lib/safe-json";

export const RECENTLY_VIEWED_STORAGE_KEY = "scalius:recently-viewed:v1";
/** Most products kept and shown (Amazon shows a rail of about a dozen). */
export const RECENTLY_VIEWED_LIMIT = 12;

export interface RecentlyViewedEntry {
  slug: string;
  name: string;
  /** A card-sized photo URL (https or same-origin path), or null. */
  image: string | null;
}

/** The inline script a product page runs to record its view (the newest first, each product once). */
export function recentlyViewedRecordScript(entry: RecentlyViewedEntry): string {
  return `(function(){try{var k=${serializeJsonForInlineScript(RECENTLY_VIEWED_STORAGE_KEY)},e=${serializeJsonForInlineScript(entry)},s=localStorage,l=JSON.parse(s.getItem(k)||"[]");if(!Array.isArray(l))l=[];l=l.filter(function(x){return x&&typeof x.slug==="string"&&x.slug!==e.slug});l.unshift(e);s.setItem(k,JSON.stringify(l.slice(0,${RECENTLY_VIEWED_LIMIT})))}catch(_){}})();`;
}

/**
 * The inline script that fills a recently-viewed island (`root`'s id) from
 * this browser's list, then shows it. It runs as the parser reaches it,
 * before the section paints, so filling it shifts nothing; with no list, or
 * storage blocked, the section stays hidden. Entries are drawn with DOM
 * text and attributes only, and only safe handles and image URLs are used.
 */
export function recentlyViewedRenderScript(rootId: string): string {
  return `(function(){try{var r=document.getElementById(${serializeJsonForInlineScript(rootId)});if(!r)return;var l=JSON.parse(localStorage.getItem(${serializeJsonForInlineScript(RECENTLY_VIEWED_STORAGE_KEY)})||"[]");if(!Array.isArray(l))return;var u=r.querySelector("[data-recently-viewed-list]"),n=0;l.slice(0,${RECENTLY_VIEWED_LIMIT}).forEach(function(x){if(!x||typeof x.slug!=="string"||!x.slug||x.slug.length>200||typeof x.name!=="string"||!x.name.trim())return;var li=document.createElement("li");li.className="w-28 shrink-0 snap-start sm:w-36 lg:w-40";var a=document.createElement("a");a.href="/products/"+encodeURIComponent(x.slug);a.className="group block";var f=document.createElement("div");f.className="aspect-square overflow-hidden rounded-lg bg-muted";if(typeof x.image==="string"&&/^(https:\\/\\/|\\/(?!\\/))/.test(x.image)){var i=document.createElement("img");i.src=x.image;i.alt="";i.loading="lazy";i.decoding="async";i.width=320;i.height=320;i.className="h-full w-full object-cover";f.appendChild(i)}var p=document.createElement("p");p.className="mt-2 line-clamp-2 text-sm text-foreground group-hover:underline";p.textContent=x.name.trim();a.appendChild(f);a.appendChild(p);li.appendChild(a);u.appendChild(li);n++});if(n>0)r.hidden=false}catch(_){}})();`;
}
