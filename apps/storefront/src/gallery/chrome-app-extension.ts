// The gallery's own theme app for the buyer's pages (chrome-app.ts), installed
// only in the gallery server under two ids: `gallery.chrome` with a stylesheet
// a theme writes for its shadow root, and `forged.chrome` with one that aims
// at the page (its fields, its body, `:root:has(...)`) and tries to lift its
// host over it. Both declare `buyerPages` on their header and footer skins,
// as an approved grant lists them. Never part of a build.
import type { StorefrontExtension } from "@scalius/shared/plugins/storefront-components";
import { BUNDLED_STOREFRONT_EXTENSIONS } from "../extensions/bundled.gen";
import type { BundledStorefrontExtension } from "../lib/extensions/loaders";

/** What a theme writes for its chrome on a buyer page: its own markup, its host, the page's scheme on the host. */
export const GALLERY_CHROME_SHEET = [
  ":root,:host{--gc-gap:8px}",
  ".gc-header{display:flex;flex-wrap:wrap;align-items:center;gap:var(--gc-gap);padding:8px 16px;border-bottom:1px solid var(--border)}",
  ':host([data-color-scheme="light"]) .gc-logo{color:rgb(17, 17, 17)}',
  ':host([data-color-scheme="dark"]) .gc-logo{color:rgb(250, 250, 250)}',
  ".gc-logo{inline-size:var(--gc-logo-width);font-weight:700}",
  ".gc-shell{position:sticky;top:0}",
  ".gc-count:not(:empty){margin-inline-start:4px;font-weight:700}",
  ".gc-cover{display:none}",
  ".gc-drawer{inset:0 auto 0 0;inline-size:min(20rem,90vw);block-size:100dvh;margin:0;padding:16px;background:var(--background);color:var(--foreground)}",
  ".gc-drawer a{display:block;padding:8px 0}",
  ".gc-footer{display:flex;flex-wrap:wrap;gap:16px;padding:24px 16px;border-top:1px solid var(--border)}",
].join("");

/**
 * A hostile theme's sheet, every rule a sheet may hold (the store refuses
 * `host-context`, `@import`, `@font-face` and `@property`): it aims at the
 * page's controls and body, reads the page with `:root:has()`, lifts its host
 * over the page (even inside the guard's own layer name), and draws a fixed
 * layer, a huge shadow and a filter over the whole screen.
 */
export const GALLERY_FORGED_SHEET = [
  GALLERY_CHROME_SHEET,
  "input,button,select,textarea,a{display:none!important;visibility:hidden!important;color:transparent!important;pointer-events:none!important}",
  "body{background:rgb(255, 0, 0)!important;transform:translateY(100px)!important}",
  ":root:has(input) body,:root:has(main) main{outline:50px solid rgb(255, 0, 0)!important;opacity:0!important}",
  "main *{visibility:hidden!important}",
  ":host{position:fixed!important;inset:0!important;z-index:2147483647!important;contain:none!important;display:block!important;margin-block-end:-100vh!important;transform:translateY(40vh)!important;overflow:visible!important}",
  ":host(*){position:absolute!important;contain:none!important}",
  // In the guard's own layer name, more specific than its rule: imported into `theme`, it nests as `theme.scalius-guard`.
  "@layer scalius-guard{:host(:not(#a#b)){contain:none!important;position:fixed!important;inset:0!important;z-index:2147483647!important}}",
  ".gc-cover{display:block!important;position:fixed!important;inset:0!important;z-index:2147483647!important;background:rgba(255, 0, 0, 0.9)!important;font-size:48px}",
  ".gc-header{box-shadow:0 0 0 100vmax rgb(255, 0, 0)!important;outline:100vmax solid rgb(255, 0, 0)!important}",
].join("");

const extension = (pluginId: string, release: string): StorefrontExtension => ({
  pluginId,
  version: "1.0.0",
  source: "bundled",
  release,
  sections: [],
  sectionSettings: {},
  skins: [
    { id: "gallery_header", target: "header", settings: [], buyerPages: true },
    { id: "gallery_footer", target: "footer", settings: [], buyerPages: true },
  ],
  components: [],
  islands: ["menu"],
  stylesheet: true,
  connect: [],
});

export const GALLERY_CHROME_EXTENSION = extension("gallery.chrome", `c4c0e1${"0".repeat(58)}`);
export const GALLERY_FORGED_CHROME_EXTENSION = extension("forged.chrome", `f0c0e1${"0".repeat(58)}`);

/** Adds both to the storefront's compiled apps for this gallery process. */
export function installGalleryChromeApps(): void {
  const bundled = BUNDLED_STOREFRONT_EXTENSIONS as Record<string, BundledStorefrontExtension>;
  for (const [app, sheet] of [[GALLERY_CHROME_EXTENSION, GALLERY_CHROME_SHEET], [GALLERY_FORGED_CHROME_EXTENSION, GALLERY_FORGED_SHEET]] as const) {
    bundled[app.pluginId] ??= {
      release: app.release,
      module: () => import("./chrome-app") as ReturnType<BundledStorefrontExtension["module"]>,
      files: async () => ({ FILES: { "styles.css": { type: "text/css; charset=utf-8", text: sheet } } }),
    };
  }
}
