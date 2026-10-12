/** Library choices are read-only render inputs, never URLs to fetch or draft writes. */
import { presenceOfPath, stripPresencePath } from "@scalius/shared/markets";
import { parsePluginSurfaceKey } from "@scalius/shared/plugins/storefront";
import { STOREFRONT_SECTION_RENDERERS, storefrontSectionDefault, type StorefrontPreviewScope, type StorefrontSection, type StorefrontSectionType } from "@scalius/shared/storefront-theme";
import { normalizeThemePreviewRoutePath } from "./theme-preview-route";

export function readLibrarySelection(url: URL): { section: StorefrontSection; scope: StorefrontPreviewScope; path: string; presence: string | null; nonce: string } | null {
  if ([...url.searchParams.keys()].some((key) => !["section", "page", "v"].includes(key))
    || [...new Set(url.searchParams.keys())].some((key) => url.searchParams.getAll(key).length !== 1)) return null;
  const key = url.searchParams.get("section") ?? "";
  const raw = url.searchParams.get("page") ?? "";
  const nonce = url.searchParams.get("v") ?? "";
  if (!/^[a-zA-Z0-9-]{1,64}$/.test(nonce) || !raw || raw.includes("?")
    || normalizeThemePreviewRoutePath(raw) !== raw) return null;
  const presence = presenceOfPath(raw);
  const path = presence ? stripPresencePath(raw, presence) : raw;
  let scope: StorefrontPreviewScope;
  if (path === "/") scope = { kind: "home" };
  else if (path.startsWith("/pages/")) scope = { kind: "landing", slug: path.slice(7) };
  else if (path === "/cart") scope = { kind: "template", template: "cart", main: 0 };
  else if (path.startsWith("/products/")) scope = { kind: "template", template: "product", main: 0 };
  else if (path.startsWith("/categories/")) scope = { kind: "template", template: "collection", main: 0 };
  else if (path.startsWith("/collections/")) scope = { kind: "template", template: "collection", main: 0 };
  else if (/^\/[A-Za-z0-9_-]+$/.test(path) && !["/search", "/products", "/categories", "/collections"].includes(path)) scope = { kind: "template", template: "page", main: 0 };
  else return null;
  const section: StorefrontSection | null = key !== "app" && (STOREFRONT_SECTION_RENDERERS as readonly string[]).includes(key)
    ? storefrontSectionDefault(key as StorefrontSectionType, "library-section")
    : parsePluginSurfaceKey(key)
      // The preview API resolves these through resolvePluginSettingValues,
      // exactly the defaults the dashboard inserts, including media/lists.
      ? { id: "library-section", type: "app", version: 1, settings: { app: key, values: {} } }
      : null;
  return section ? { section, scope, path, presence, nonce } : null;
}

/** Installed before island modules; this document is a view, not a buyer journey. */
export function libraryPreviewScript(origin: string, nonce: string): string {
  return `(() => {
    const stop = (event) => { event.preventDefault(); event.stopImmediatePropagation(); };
    for (const name of ['click', 'auxclick', 'submit']) window.addEventListener(name, stop, true);
    // Canonical units and app wrappers are display:contents, so inspect the
    // boxes they hold (the same boundary used by the main preview bridge).
    const drawn = (element) => {
      const style = getComputedStyle(element);
      if (style.visibility === 'hidden' || style.display === 'none') return false;
      if (style.display !== 'contents') return element.getBoundingClientRect().height > 0;
      if ([...element.children].some(drawn)) return true;
      const range = document.createRange();
      range.selectNodeContents(element);
      return range.getBoundingClientRect().height > 0;
    };
    const ready = () => {
      const units = [...document.querySelectorAll('[data-home-render-unit]')];
      const visible = units.some(drawn);
      const failed = document.querySelector('[data-library-render-failed]') !== null;
      parent.postMessage({type: 'scalius:library-preview', v: ${JSON.stringify(nonce)}, state: failed ? 'failed' : visible ? 'ready' : 'empty'}, ${JSON.stringify(origin)});
    };
    window.addEventListener('load', ready, {once: true});
  })();`;
}
