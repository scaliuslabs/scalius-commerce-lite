// @vitest-environment node
/**
 * The presence HTML rewriter in workerd, with the real HTMLRewriter
 * (docs/MARKETS-DESIGN.md D4): a presence page's own links, merchant and
 * app markup included, stay inside the presence; scripts, assets, other
 * origins and alternates are untouched.
 */
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const MODULE = fileURLToPath(new URL("./market-presence.ts", import.meta.url));
const ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
let mf: Miniflare;

beforeAll(async () => {
  const bundle = await build({
    stdin: {
      contents: `import { localizePresenceResponse } from ${JSON.stringify(MODULE)};
        export default {
          async fetch(request) {
            const page = new Response(await request.text(), { headers: { "Content-Type": "text/html; charset=utf-8" } });
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

const render = async (html: string) => (await mf.dispatchFetch("https://shop.example/", { method: "POST", body: html })).text();

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
