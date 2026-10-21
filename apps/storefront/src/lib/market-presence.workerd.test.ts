// @vitest-environment node
/**
 * The presence HTML rewriter in workerd, with the real HTMLRewriter
 * (docs/MARKETS-DESIGN.md D4): a presence page's own links, merchant and
 * app markup included, stay inside the presence; scripts, assets, other
 * origins and alternates are untouched. Its native selector filters are
 * proved byte-identical to the plain rewriter (every link element through
 * JS, `presenceHref` deciding) on a generated corpus.
 */
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const MODULE = fileURLToPath(new URL("./market-presence.ts", import.meta.url));
const MARKETS = fileURLToPath(new URL("../../../../packages/shared/src/markets.ts", import.meta.url));
const ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
let mf: Miniflare;

/** The plain rewriter: every link element crosses into JS and `presenceHref` decides. */
const REFERENCE = `
  function reference(response) {
    let html = new HTMLRewriter();
    for (const [selector, attribute] of [["a[href]", "href"], ["area[href]", "href"], ["form[action]", "action"], ["button[formaction]", "formaction"], ["input[formaction]", "formaction"]]) {
      html = html.on(selector, {
        element(element) {
          if (element.hasAttribute("hreflang")) return;
          const value = element.getAttribute(attribute);
          if (value === null) return;
          const next = presenceHref("en-in", value, "https://shop.example");
          if (next !== value) element.setAttribute(attribute, next);
        },
      });
    }
    return html.transform(response);
  }`;

beforeAll(async () => {
  const bundle = await build({
    stdin: {
      contents: `import { localizePresenceResponse } from ${JSON.stringify(MODULE)};
        import { presenceHref } from ${JSON.stringify(MARKETS)};
        ${REFERENCE}
        export default {
          async fetch(request) {
            const page = new Response(await request.text(), { headers: { "Content-Type": "text/html; charset=utf-8" } });
            if (new URL(request.url).pathname === "/reference") return reference(page);
            return localizePresenceResponse(page, "en-in", "https://shop.example");
          },
        };`,
      resolveDir: ROOT,
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "neutral",
    mainFields: ["module", "main"],
    write: false,
    logLevel: "silent",
  });
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle.outputFiles[0]!.text, compatibilityDate: "2026-10-01" }));
}, 60_000);

afterAll(async () => {
  await mf?.dispose();
});

const render = async (html: string, path = "/") => (await mf.dispatchFetch(`https://shop.example${path}`, { method: "POST", body: html })).text();

const VALUES = [
  "/", "/products/linen", "/products/linen?variant=v1#reviews", "/categories/eid/", "/a//b", "/en-in", "/en-in/cart", "/hi-in/x", "/EN-IN/x",
  "/media/x.webp", "/api/newsletter/subscribe", "/localization", "/robots.txt", "/x.y/z", "//cdn.example/x", "/\\evil", "/?q=1", "/#top",
  "https://shop.example", "https://shop.example/pages/about?x=1#y", "HTTPS://SHOP.EXAMPLE/Cart", "http://shop.example/x", "https://shop.example:443/x",
  "https://user@shop.example/x", "https://shop.example/a b", "https://shop.example./x", "https://other.example/x", "https:/shop.example/x",
  "#", "#reviews", " #x", "mailto:a@b.c", "MAILTO:a@b.c", " mailto:a@b.c", "tel:+880", "Tel:+880", "telx", "javascript:void(0)", "whatsapp://send",
  "", " ", "products/x", "./x", "../x", "?page=2", "&#47;products/x", "&#x2F;x", "/products/x&amp;y", '/a"b', "/a'b", "/ü/x",
];
/** Every character `String.prototype.trim` removes, and a few it keeps. */
const PADS = [
  "", " ", "  ", "\t", "\n", "\r\n", "\r", "\v", "\f", " ", " ", " ", " ", " ", " ", " ", " ", "　", "﻿",
  "​", "\u0001",
];
const TAGS: ReadonlyArray<readonly [open: string, attribute: string, close: string]> = [
  ["a", "href", "</a>"], ["area", "href", ""], ["form", "action", "</form>"], ["button", "formaction", "</button>"], ["input", "formaction", ""],
  ["link", "href", ""], ["img", "src", ""], ["A", "HREF", "</A>"], ["FORM", "Action", "</FORM>"], ["button", "action", "</button>"],
];

/** Every value, padded both ends, on every element, with alternates, odd quoting and raw-text contexts. */
function corpus(): string[] {
  const documents: string[] = [];
  let index = 0;
  for (const value of VALUES) {
    const parts: string[] = [];
    for (const lead of PADS) {
      for (const trail of ["", " ", "\t", " ", "﻿"]) {
        const attribute = `${lead}${value}${trail}`;
        const quoted = attribute.includes('"') ? `'${attribute}'` : `"${attribute}"`;
        const [tag, name, close] = TAGS[index % TAGS.length]!;
        const extra = index % 7 === 0 ? ' hreflang="bn-BD"' : index % 11 === 0 ? " HREFLANG" : index % 13 === 0 ? ' class="x"  data-x=y' : "";
        parts.push(`<${tag}${extra} ${name}=${quoted}>${close}`);
        index += 1;
      }
    }
    if (value && !/[\s"'<>=`]/.test(value)) parts.push(`<a href=${value}>u</a><form action=${value} method=post></form><a href='${value}' >s</a>`);
    const html = value.replaceAll('"', "&quot;");
    parts.push(`<a href="${html}" href="/second">dup</a><svg><a href="${html}"><text>s</text></a></svg><map><area href="${html}"></map>`);
    parts.push(`<script>document.write('<a href="${html}">')</script><style>a[href="${html}"]{}</style><textarea><a href="/t"></textarea>`);
    parts.push(`<!-- <a href="/c"> --><template><a href="${html}">t</a></template><noscript><a href="/n">n</a></noscript>`);
    documents.push(`<!doctype html><html><head><title><a href="/title"></title></head><body>${parts.join("\n")}</body></html>`);
  }
  return documents;
}

describe("presence HTML in workerd", () => {
  it("keeps every page link and form inside the presence", async () => {
    const html = [
      '<a href="/">Home</a>',
      '<a href="/products/linen?variant=v1#reviews">Linen</a>',
      '<a href="https://shop.example/categories/eid">Eid</a>',
      // Merchant rich text and app output are rewritten like the theme's own links.
      '<div class="rich-content"><p>See <a href="/pages/size-guide">sizes</a></p></div>',
      '<form method="post" action="/buy/linen"><button formaction="/cart">Cart</button></form>',
      '<form action="/search"><input name="q"></form>',
    ].join("");
    expect(await render(html)).toBe([
      '<a href="/en-in">Home</a>',
      '<a href="/en-in/products/linen?variant=v1#reviews">Linen</a>',
      '<a href="https://shop.example/en-in/categories/eid">Eid</a>',
      '<div class="rich-content"><p>See <a href="/en-in/pages/size-guide">sizes</a></p></div>',
      '<form method="post" action="/en-in/buy/linen"><button formaction="/en-in/cart">Cart</button></form>',
      '<form action="/en-in/search"><input name="q"></form>',
    ].join(""));
  });

  it("matches the plain rewriter byte for byte on a generated corpus", async () => {
    let rewritten = 0;
    for (const html of corpus()) {
      const [actual, expected] = [await render(html), await render(html, "/reference")];
      expect(actual).toBe(expected);
      if (expected !== html) rewritten += 1;
    }
    // Most values are rewritten somewhere (a page path, or trimmed whitespace).
    expect(rewritten).toBeGreaterThan(VALUES.length / 2);
  });

  it("leaves assets, APIs, other origins, alternates, scripts and already-localized links alone", async () => {
    const html = [
      '<link rel="canonical" href="https://shop.example/en-in/products/linen">',
      '<link rel="alternate" hreflang="bn-BD" href="https://shop.example/products/linen">',
      '<a hreflang="bn-BD" href="/">Bangladesh store</a>',
      '<a href="/media/linen.webp">Photo</a>',
      '<a href="/api/product-feed.xml">Feed</a>',
      '<a href="https://facebook.com/shop">Facebook</a>',
      '<a href="//cdn.example/x">CDN</a>',
      '<a href="#top">Top</a>',
      '<a href="/en-in/cart">Cart</a>',
      '<form action="/localization" method="post"></form>',
      '<script>location.href = "/cart";</script>',
      '<img src="/products/linen.jpg">',
    ].join("");
    expect(await render(html)).toBe(html);
  });
});
