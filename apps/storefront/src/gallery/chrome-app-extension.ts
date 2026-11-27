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
  ".gc-cover,.gc-cover2{display:none}",
  ".gc-more-panel{margin:0;padding:12px;list-style:none;background:var(--background);color:var(--foreground)}",
  ".gc-drawer{inset:0 auto 0 0;inline-size:min(20rem,90vw);block-size:100dvh;margin:0;padding:16px;background:var(--background);color:var(--foreground)}",
  ".gc-drawer a{display:block;padding:8px 0}",
  ".gc-footer{display:flex;flex-wrap:wrap;gap:16px;padding:24px 16px;border-top:1px solid var(--border)}",
].join("");

/** The colours a hostile sheet paints with: a host control's pixel that reads as one of them is covered. */
export const GALLERY_FORGED_COLOURS = ["rgb(0, 255, 0)", "rgb(255, 0, 255)"] as const;

/**
 * A hostile theme's sheet, every rule the store's check lets through: it aims
 * at the page's controls and body, reads the page with `:root:has()`, lifts
 * its host over the page (even inside the guard's own layer name), paints the
 * host's own effects far outside its box (an outline, a shadow, a drop-shadow
 * chain, a reflection, a border image, a clip margin), grows the header to
 * push the account down, and draws a fixed and an absolute layer over the
 * whole screen (the review's probes, rc.1).
 */
export const GALLERY_FORGED_SHEET = [
  GALLERY_CHROME_SHEET,
  "input,button,select,textarea,a{display:none!important;visibility:hidden!important;color:transparent!important;pointer-events:none!important}",
  "body{background:rgb(255, 0, 255)!important;transform:translateY(100px)!important}",
  ":root:has(input) body,:root:has(main) main{outline:50px solid rgb(255, 0, 255)!important;opacity:0!important}",
  "main *{visibility:hidden!important}",
  ":host{position:fixed!important;inset:0!important;z-index:2147483647!important;contain:none!important;display:block!important;margin-block-end:-100vh!important;transform:translateY(40vh)!important;overflow:visible!important;overflow-clip-margin:2000px!important;",
  "min-block-size:1200px!important;outline:3000px solid rgb(0, 255, 0)!important;box-shadow:0 0 0 3000px rgb(0, 255, 0)!important;",
  "filter:drop-shadow(0 60px 0 rgb(0, 255, 0)) drop-shadow(0 120px 0 rgb(0, 255, 0)) drop-shadow(0 240px 0 rgb(0, 255, 0))!important;-webkit-box-reflect:below 0px!important;",
  "border:1px solid transparent!important;border-image:linear-gradient(rgb(0, 255, 0),rgb(0, 255, 0)) 1 / 1px / 3000px!important;background:rgb(0, 255, 0)!important}",
  "@layer scalius-guard{:host([data-chrome]){contain:none!important;position:fixed!important;inset:0!important;z-index:2147483647!important;overflow-clip-margin:2000px!important}}",
  ".gc-cover{display:block!important;position:fixed!important;inset:0!important;z-index:2147483647!important;background:rgb(255, 0, 255)!important;font-size:48px}",
  ".gc-cover2{display:block!important;position:absolute!important;top:0!important;left:0!important;width:100vw!important;height:2000px!important;z-index:2147483647!important;background:rgb(0, 255, 0)!important}",
  ".gc-header{box-shadow:0 0 0 100vmax rgb(255, 0, 255)!important;outline:100vmax solid rgb(255, 0, 255)!important}",
].join("");

/**
 * Hostile sheets the store's check lets through, each one effect alone (the
 * review's probes, rc.1): the frame must hold every one to the chrome's box,
 * and an open popover to its own box, narrower than the screen.
 */
export const GALLERY_DRAWN_PROBES: Readonly<Record<string, string>> = {
  outline: ":host{outline:3000px solid rgb(0, 255, 0)}",
  "box-shadow": ":host{box-shadow:0 0 0 3000px rgb(0, 255, 0)}",
  "border-image": ":host{border:1px solid transparent;border-image:linear-gradient(rgb(0, 255, 0),rgb(0, 255, 0)) 1 / 1px / 3000px}",
  "drop-shadow": ":host{background:rgb(0, 0, 0);filter:drop-shadow(0 60px 0 rgb(0, 255, 0)) drop-shadow(0 120px 0 rgb(0, 255, 0)) drop-shadow(0 240px 0 rgb(0, 255, 0))}",
  reflect: ":host{background:rgb(0, 255, 0);min-height:400px;-webkit-box-reflect:below 0px}",
  "clip-margin-absolute": ":host{overflow-clip-margin:2000px} .gc-cover2{display:block;position:absolute;top:0;left:0;width:100vw;height:2000px;background:rgb(0, 255, 0)}",
  "clip-margin-fixed": ":host{overflow-clip-margin:2000px} .gc-cover{display:block;position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgb(0, 255, 0)}",
  tall: ":host{min-height:1200px;background:rgb(0, 255, 0)}",
  "popover-cover": ".gc-more-panel:popover-open{inset:0;inline-size:100vw;max-inline-size:none;block-size:100vh;background:rgb(255, 0, 255);transform:scale(3);outline:3000px solid rgb(255, 0, 255);box-shadow:0 0 0 3000px rgb(255, 0, 255)}",
};

/** Hostile sheets the store must not use at all (the review's probes, rc.1): each would reach past the shadow root. */
export const GALLERY_REFUSED_SHEETS: Readonly<Record<string, string>> = {
  "url-comment": "a{background:url(/*)}:host-context(body) .gc-logo{background-image:url(/apps/forged.chrome/leak?hostcontext)}/**/",
  "url-comment-import": "x url(/*){} @import url(/evil.css); /**/",
  "layer-import": "@layer a{b{c:url(/*)}} @import url(/evil.css);/**/",
  "host-is": ":host(:is(body *)) .gc-logo{background-image:url(/apps/forged.chrome/leak?host-is)}",
  "host-has-sibling": ":host(:has(~ *)) .gc-sign-in{background-image:url(/apps/forged.chrome/leak?host-has)}",
  "host-chained-has": ":host:has(~ script) .gc-cart{background-image:url(/apps/forged.chrome/leak?host-chained)}",
  "font-face": "@font-face{font-family:Probe;src:url(/apps/forged.chrome/leak?font)}.gc-logo{font-family:Probe}",
  "unbalanced": "} @layer scalius-guard{:host(:not(#a#b)){contain:none!important}} .x{",
};

/** A UTF-16LE sheet with a byte-order mark: a store that decoded it as UTF-8 would see none of it. */
export function galleryUtf16Sheet(text: string): Uint8Array {
  const bytes = new Uint8Array(2 + text.length * 2);
  bytes[0] = 0xff;
  bytes[1] = 0xfe;
  for (let index = 0; index < text.length; index += 1) bytes[2 + index * 2] = text.charCodeAt(index);
  return bytes;
}

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

function install(app: StorefrontExtension, sheet: string | Uint8Array): void {
  const bundled = BUNDLED_STOREFRONT_EXTENSIONS as Record<string, BundledStorefrontExtension>;
  const file = typeof sheet === "string"
    ? { type: "text/css; charset=utf-8", text: sheet }
    : { type: "text/css; charset=utf-8", base64: btoa(String.fromCharCode(...sheet)) };
  bundled[app.pluginId] = {
    release: app.release,
    module: () => import("./chrome-app") as ReturnType<BundledStorefrontExtension["module"]>,
    files: async () => ({ FILES: { "styles.css": file } }),
  };
}

/** Adds both to the storefront's compiled apps for this gallery process. */
export function installGalleryChromeApps(): void {
  install(GALLERY_CHROME_EXTENSION, GALLERY_CHROME_SHEET);
  install(GALLERY_FORGED_CHROME_EXTENSION, GALLERY_FORGED_SHEET);
}

const probes = new Map<string, StorefrontExtension>();

/** A theme app of its own for one probe sheet (`probe<n>.chrome`, its own release), installed now; its extension. */
export function installGalleryProbeChromeApp(name: string, sheet: string | Uint8Array): StorefrontExtension {
  const index = String(probes.size + 1);
  const app = extension(`probe${index}.chrome`, `${index.padStart(6, "0")}${"0".repeat(58)}`);
  install(app, sheet);
  probes.set(name, app);
  return app;
}

/** The probe app installed under this name, if any. */
export function galleryProbeChromeApp(pluginId: string): StorefrontExtension | null {
  return [...probes.values()].find((app) => app.pluginId === pluginId) ?? null;
}
