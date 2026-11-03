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
 *   `colorSchemeToggle()`) flips the scheme and remembers it; other tabs follow.
 *
 * Without JavaScript the theme's scheme stands (`system` through
 * `prefers-color-scheme`) and the switches stay hidden.
 */
import type { ThemeColorScheme } from "@/lib/theme-paint";
import { serializeJsonForInlineScript } from "@/lib/safe-json";

/** Where a buyer's choice is kept, on their device only. */
export const COLOR_SCHEME_STORAGE_KEY = "scalius:color-scheme";

/**
 * The head script for a theme that shows its dark colours ("" when the
 * server's attribute is already final). `remember: false` (the theme
 * editor's preview) neither reads nor writes the buyer's choice, so the
 * merchant's own choice never colours the canvas.
 */
export function colorSchemeBootScript(colorScheme: ThemeColorScheme | null, remember = true): string {
  if (!colorScheme || (colorScheme.scheme !== "system" && !colorScheme.toggle)) return "";
  const key = serializeJsonForInlineScript(COLOR_SCHEME_STORAGE_KEY);
  const toggle = colorScheme.toggle;
  return [
    "(function(){",
    'var r=document.documentElement,t=r.getAttribute("data-color-scheme"),m=window.matchMedia("(prefers-color-scheme: dark)"),c=null;',
    "function v(x){return x===\"light\"||x===\"dark\"?x:null}",
    'function a(){r.setAttribute("data-color-scheme",c||(t==="system"?(m.matches?"dark":"light"):t))}',
    toggle && remember ? `try{c=v(localStorage.getItem(${key}))}catch(e){}` : "",
    'a();if(t==="system")m.addEventListener("change",a);',
    toggle ? 'r.setAttribute("data-color-scheme-switch","");' : "",
    toggle
      ? 'document.addEventListener("click",function(e){var b=e.target instanceof Element?e.target.closest("[data-color-scheme-toggle]"):null;'
        + 'if(!b||e.defaultPrevented)return;c=r.getAttribute("data-color-scheme")==="dark"?"light":"dark";a();'
        + (remember ? `try{localStorage.setItem(${key},c)}catch(e){}` : "")
        + "});"
      : "",
    toggle && remember ? `window.addEventListener("storage",function(e){if(e.key===${key}){c=v(e.newValue);a()}});` : "",
    "})();",
  ].join("");
}
