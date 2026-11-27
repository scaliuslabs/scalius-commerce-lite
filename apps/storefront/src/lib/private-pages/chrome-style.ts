// The style of a theme's chrome on a buyer page (components/private/PrivateChrome.astro):
// one style element in its shadow root that orders three cascade layers and
// imports two sheets into them.
//
// - `scalius-guard`, declared first: the host's rules, all `!important`. For
//   important declarations the first layer wins over every later one, and the
//   theme's sheet is imported into a later layer (`theme`), where even its own
//   `@layer` rules nest (`theme.<name>`): nothing the theme writes, however
//   specific or important, outranks the guard. It keeps the shadow host a
//   plain block in the page's flow, never moved or stacked over the page, and
//   paint-contained, so nothing the theme draws leaves the host's own box and
//   its fixed and absolute layers are held to it. The one way out is the top
//   layer: the menu drawer, a `popover="auto"` only a buyer's press opens.
//   The signed-in and guest versions (`whenSignedIn()`, `whenSignedOut()`)
//   follow the host's `data-scalius-signed-in`.
// - `scalius-base`: the store's base (styles/buyer-chrome.css: the preflight
//   a theme's markup sits on in the page, and the page's font and colour).
// - `theme`: the app's own stylesheet, the same cached file public pages link,
//   read first by the store (`buyerChromeCssProblem`).

/** The host's rules (see above). */
export const BUYER_CHROME_GUARD = [
  ":host{display:block!important;position:static!important;float:none!important;margin:0!important;inset:auto!important;",
  "z-index:auto!important;transform:none!important;translate:none!important;rotate:none!important;scale:none!important;",
  "offset-path:none!important;order:0!important;max-inline-size:100%!important;contain:paint!important;content-visibility:visible!important}",
  ':host(:not([data-scalius-signed-in])) [data-scalius-when="signed-in"],:host([data-scalius-signed-in]) [data-scalius-when="signed-out"]{display:none!important}',
].join("");

/** A URL as a CSS string: no quote, backslash, line break or `<` can end it or the style element. */
function cssUrl(url: string): string {
  return `url("${url.replace(/["\\\n\r\f<>]/g, (character) => `\\${character.codePointAt(0)!.toString(16)} `)}")`;
}

/** The shadow root's style element text: the layer order, the store's base, the theme's sheet (when it ships one) and the guard. */
export function buyerChromeShadowStyle(base: string, theme: string | null): string {
  return [
    "@layer scalius-guard,scalius-base,theme;",
    `@import ${cssUrl(base)} layer(scalius-base);`,
    theme ? `@import ${cssUrl(theme)} layer(theme);` : "",
    `@layer scalius-guard{${BUYER_CHROME_GUARD}}`,
  ].join("");
}
