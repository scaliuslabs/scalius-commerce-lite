/**
 * The colour scheme on every page, private ones included: the server renders
 * the theme's scheme on `<html data-color-scheme>` (the same HTML for every
 * buyer, so caches never vary), and this inline head script settles it
 * before the first paint:
 *
 * - `system` becomes `light` or `dark` from the device, and follows it;
 * - with the theme's switch on, the buyer's own choice (this device's
 *   storage) wins, `data-color-scheme-switch` shows the switches, and a click
 *   on any `[data-color-scheme-toggle]` (the core header's, or a skin's
 *   `colorSchemeToggle()`) flips the scheme and remembers it; other tabs, and
 *   a page restored from the back/forward cache, follow. Every switch is
 *   `aria-pressed` while dark colours show, so its new state is announced
 *   under one stable name. The store's switch (the core header's, or the one
 *   it adds to a header skin) yields to one a header or footer skin, or an
 *   app in their slots, drew: a page shows one (`data-color-scheme-switch-yields`
 *   then frees the room the header kept for it). One drawn after a skin
 *   that places no slot stays hidden until it is in the skin's `<header>`
 *   (its landmark), so it never shifts the page.
 *
 * It is its own script, and a failure inside it is swallowed: nothing else
 * on the page waits on it. Without JavaScript the theme's scheme stands
 * (`system` through `prefers-color-scheme`) and the switches stay hidden.
 */
import type { ThemeColorScheme } from "@/lib/theme-paint";
import { serializeJsonForInlineScript } from "@/lib/safe-json";

/** A switch a header or footer skin (or an app in their slots) drew: the store's then yields to it. */
const SKIN_DRAWN_SWITCH = "[data-storefront-header] [data-color-scheme-toggle]:not([data-sx-host-color-scheme-toggle]), [data-storefront-footer] [data-color-scheme-toggle]:not([data-sx-host-color-scheme-toggle])";

/** Where a buyer's choice is kept, on their device only. */
export const COLOR_SCHEME_STORAGE_KEY = "scalius:color-scheme";

/**
 * The head script for a theme that shows its dark colours ("" when the
 * server's attribute is already final). `remember: false` (the theme
 * editor's canvas) neither reads nor writes the buyer's choice and does not
 * follow the device: the editor shows the colours it is editing.
 */
export function colorSchemeBootScript(colorScheme: ThemeColorScheme | null, remember = true): string {
  if (!colorScheme || (colorScheme.scheme !== "system" && !colorScheme.toggle)) return "";
  const key = serializeJsonForInlineScript(COLOR_SCHEME_STORAGE_KEY);
  const toggle = colorScheme.toggle;
  const stored = toggle && remember;
  return [
    "(function(){try{",
    'var r=document.documentElement,t=r.getAttribute("data-color-scheme"),m=window.matchMedia("(prefers-color-scheme: dark)"),c=null;',
    'function v(x){return x==="light"||x==="dark"?x:null}',
    toggle
      ? 'function p(){var d=r.getAttribute("data-color-scheme")==="dark"?"true":"false";'
        + 'document.querySelectorAll("[data-color-scheme-toggle]").forEach(function(b){b.setAttribute("aria-pressed",d)})}'
      : "",
    `function a(){r.setAttribute("data-color-scheme",c||(t==="system"?(m.matches?"dark":"light"):t))${toggle ? ";p()" : ""}}`,
    stored ? `function s(){try{c=v(localStorage.getItem(${key}))}catch(e){}}s();` : "",
    "a();",
    remember ? 'if(t==="system")m.addEventListener("change",a);' : "",
    toggle ? 'r.setAttribute("data-color-scheme-switch","");' : "",
    // Once the page is read: every switch says its state; one switch per page (the store's yields to one a header
    // or footer skin drew: the CSS rule's fallback without :has()), and the store's sits in the header's landmark.
    toggle
      ? 'document.addEventListener("DOMContentLoaded",function(){p();'
        + `var o=document.querySelector(${serializeJsonForInlineScript(SKIN_DRAWN_SWITCH)});`
        + 'if(o)r.setAttribute("data-color-scheme-switch-yields","");'
        + 'document.querySelectorAll("[data-sx-host-color-scheme-toggle]").forEach(function(h){'
        + 'if(o){h.hidden=true;return}var d=h.closest("[data-storefront-header]");if(!d||h.parentElement!==d)return;'
        + 'var l=d.querySelector("header,[role=banner]");if(l&&!l.contains(h))l.appendChild(h);h.setAttribute("data-sx-placed","")})});'
      : "",
    toggle
      ? 'document.addEventListener("click",function(e){var b=e.target instanceof Element?e.target.closest("[data-color-scheme-toggle]"):null;'
        + 'if(!b||e.defaultPrevented)return;c=r.getAttribute("data-color-scheme")==="dark"?"light":"dark";a();'
        + (stored ? `try{localStorage.setItem(${key},c)}catch(e){}` : "")
        + "});"
      : "",
    stored ? `window.addEventListener("storage",function(e){if(e.key===${key}){c=v(e.newValue);a()}});` : "",
    // A page restored from the back/forward cache missed changes while frozen.
    remember ? `window.addEventListener("pageshow",function(e){if(e.persisted){${stored ? "s();" : ""}a()}});` : "",
    "}catch(e){}})();",
  ].join("");
}

/**
 * The CSP source that lets exactly this script run on a page whose policy
 * allows no inline script (`'sha256-…'`); null when there is no script.
 */
export async function colorSchemeScriptSource(script: string): Promise<string | null> {
  if (!script) return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(script));
  return `'sha256-${btoa(String.fromCharCode(...new Uint8Array(digest)))}'`;
}
