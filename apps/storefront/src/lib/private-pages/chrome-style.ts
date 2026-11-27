// A theme's chrome on a buyer page (components/private/PrivateChrome.astro).
//
// The boundary is structural. Each shadow host sits inside a store-owned
// frame (`BUYER_CHROME_FRAME_STYLE`), a light-DOM element nothing in the
// shadow tree can select or style: it is paint-contained and clips its
// overflow, so nothing the host or its shadow tree paints (an outline, a
// shadow, a filter, a reflection, a fixed or absolute layer, a clip margin)
// shows outside the frame's box, and the header's frame is at most half the
// screen tall, so the page's own content starts on the first screen. The one
// way out is the top layer: a popover the buyer's press opens.
//
// Inside, one style element orders three cascade layers:
// - `scalius-guard`, declared first, every rule `!important`: for important
//   declarations the first layer wins, and the theme's text sits in a later
//   layer (`theme`), where even a layer of the same name nests
//   (`theme.scalius-guard`). It keeps the host a plain block in the flow,
//   paint-contained, its open popovers clipped and narrower than the screen
//   (a strip stays to dismiss them), and follows the sign-in hint.
// - `scalius-base`: the store's base (styles/buyer-chrome.css).
// - `theme`: the app's stylesheet as the store checked it
//   (`checkedBuyerChromeSheet`), written here as text: the browser never
//   fetches the app's file, so it reads exactly what was checked.

/** The store-owned frame around each shadow host, by region: the boundary, written as the frame's own style attribute. */
export const BUYER_CHROME_FRAME_STYLE: Readonly<Record<"header" | "footer", string>> = {
  header: "display:block;contain:paint;overflow:clip;overflow-clip-margin:0px;margin:0;padding:0;max-block-size:50svh",
  footer: "display:block;contain:paint;overflow:clip;overflow-clip-margin:0px;margin:0;padding:0;max-block-size:300svh",
};

/** The host's rules (see above). */
export const BUYER_CHROME_GUARD = [
  ":host{display:block!important;position:static!important;float:none!important;margin:0!important;inset:auto!important;",
  "z-index:auto!important;transform:none!important;translate:none!important;rotate:none!important;scale:none!important;",
  "offset-path:none!important;order:0!important;max-inline-size:100%!important;contain:paint!important;overflow-clip-margin:0px!important;content-visibility:visible!important}",
  ':host(:not([data-scalius-signed-in])) [data-scalius-when="signed-in"],:host([data-scalius-signed-in]) [data-scalius-when="signed-out"]{display:none!important}',
  // An open popover (a buyer's press opened it) draws in the top layer, outside the frame: held to its own box, no wider
  // than the screen less a strip a press dismisses it on, unmoved and unscaled.
  "[popover]:popover-open{contain:paint!important;overflow:clip!important;overflow-clip-margin:0px!important;max-inline-size:calc(100vw - 48px)!important;",
  "transform:none!important;translate:none!important;rotate:none!important;scale:none!important;zoom:1!important;",
  "outline:none!important;box-shadow:none!important;filter:none!important;-webkit-box-reflect:none!important;border-image:none!important}",
].join("");

/** The shadow root's style element text: the layer order, the store's base, the theme's checked text (when it ships one) and the guard. */
export function buyerChromeShadowStyle(base: string, theme: string | null): string {
  return [
    "@layer scalius-guard,scalius-base,theme;",
    `@import url("${base.replace(/["\\\n<>]/g, (character) => `\\${character.codePointAt(0)!.toString(16)} `)}") layer(scalius-base);`,
    theme ? `@layer theme{${theme}}` : "",
    `@layer scalius-guard{${BUYER_CHROME_GUARD}}`,
  ].join("");
}
