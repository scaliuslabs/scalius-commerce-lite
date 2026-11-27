// A theme's chrome on a buyer page (components/private/PrivateChrome.astro).
//
// The boundary is structural. Each shadow host sits inside a store-owned
// frame (`BUYER_CHROME_FRAME_STYLE`), a light-DOM element nothing in the
// shadow tree can select or style: it is paint-contained and clips its
// overflow, so nothing the host or its shadow tree paints (an outline, a
// shadow, a filter, a reflection, a fixed or absolute layer, a clip margin)
// shows outside the frame's box. The header's frame is at most half the
// screen tall, so the page's own content starts on the first screen, and the
// footer's at most one screen. Nothing the theme styles is ever in the top
// layer: its popovers are lifted out as the store's own panels (`[data-buyer-chrome-panel]`,
// components/private/PrivateChrome.astro), each a frame of its own inside a
// top-layer element the store alone styles.
//
// Inside, one style element of the store's own text orders three cascade
// layers and imports the two sheets into them; no theme text is ever written
// beside the store's:
// - `scalius-guard`, declared first, every rule `!important`: it keeps the
//   host a plain block in the flow, paint-contained, and follows the sign-in
//   hint (defence in depth: the frame is the boundary).
// - `scalius-base`: the store's base (styles/buyer-chrome.css).
// - `theme`: the store's reading of the app's stylesheet, a separate file at
//   the store's own path (lib/extensions files.ts `/_buyer-chrome/...`): a
//   sheet ends where it ends, so nothing at its end reaches the guard.

import { BUYER_CHROME_FRAME_MAX_SVH } from "@scalius/shared/plugins/buyer-chrome-frame";

/** The store-owned frame around each shadow host, by region: the boundary, written as the frame's own style attribute. */
export const BUYER_CHROME_FRAME_STYLE: Readonly<Record<"header" | "footer" | "panel", string>> = {
  header: `display:block;contain:paint;overflow:clip;overflow-clip-margin:0px;margin:0;padding:0;max-block-size:${BUYER_CHROME_FRAME_MAX_SVH.header}svh`,
  footer: `display:block;contain:paint;overflow:clip;overflow-clip-margin:0px;margin:0;padding:0;max-block-size:${BUYER_CHROME_FRAME_MAX_SVH.footer}svh`,
  panel: "display:block;contain:paint;overflow:auto;overflow-clip-margin:0px;margin:0;padding:0;flex:1 1 auto;min-block-size:0",
};

/** The host's rules (see above). */
export const BUYER_CHROME_GUARD = [
  ":host{display:block!important;position:static!important;float:none!important;margin:0!important;inset:auto!important;",
  "z-index:auto!important;transform:none!important;translate:none!important;rotate:none!important;scale:none!important;",
  "offset-path:none!important;order:0!important;max-inline-size:100%!important;contain:paint!important;overflow-clip-margin:0px!important;content-visibility:visible!important}",
  ':host(:not([data-scalius-signed-in])) [data-scalius-when="signed-in"],:host([data-scalius-signed-in]) [data-scalius-when="signed-out"]{display:none!important}',
].join("");

const cssUrl = (url: string) => `url("${url.replace(/["\\\n<>]/g, (character) => `\\${character.codePointAt(0)!.toString(16)} `)}")`;

/** The shadow root's style element text, all the store's own: the layer order, the store's base, the theme's derived sheet (when it ships one), the guard. */
export function buyerChromeShadowStyle(base: string, theme: string | null): string {
  return [
    "@layer scalius-guard,scalius-base,theme;",
    `@import ${cssUrl(base)} layer(scalius-base);`,
    theme ? `@import ${cssUrl(theme)} layer(theme);` : "",
    `@layer scalius-guard{${BUYER_CHROME_GUARD}}`,
  ].join("");
}
