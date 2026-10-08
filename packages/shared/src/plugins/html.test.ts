import { describe, expect, it } from "vitest";
import { PLUGIN_HTML_MAX_ELEMENTS, PLUGIN_HTML_MAX_INPUT_BYTES, sanitizePluginHtml, sanitizePluginUrl } from "./html";
import { parsePluginPageOutput, sanitizePluginHead, serializeJsonLd } from "./storefront";

const options = { pluginId: "acme.wishlist", forms: true };
function clean(html: string, overrides: Partial<typeof options> = {}): string {
  const result = sanitizePluginHtml(html, { ...options, ...overrides });
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return result.html;
}

describe("plugin storefront HTML", () => {
  it("keeps content markup and plain text", () => {
    expect(clean('<section class="grid gap-2"><h2>Saved</h2><p>Hello <strong>you</strong> &amp; them</p><ul><li>One</li></ul></section>'))
      .toBe('<section class="grid gap-2"><h2>Saved</h2><p>Hello <strong>you</strong> &amp; them</p><ul><li>One</li></ul></section>');
  });

  it("drops scripts, styles, iframes, svg and templates with their content", () => {
    const html = clean('<div>a<script>alert(1)</script><style>body{}</style><iframe src="https://x.com"></iframe><svg onload="x"><script>1</script></svg><template><b>t</b></template><noscript>n</noscript>b</div>');
    expect(html).toBe("<div>ab</div>");
  });

  it("drops event handlers, inline style, ids and names outside form controls", () => {
    expect(clean('<p onclick="x()" style="color:red" id="main" name="x" data-app="1" aria-label="L" title="t">x</p>'))
      .toBe('<p data-app="1" aria-label="L" title="t">x</p>');
  });

  it("never renders an h1 (the page owns it); unknown tags keep their text", () => {
    expect(clean("<h1>Big</h1><blink>old</blink>")).toBe("Bigold");
  });

  it("allows links to store paths, https, mailto, tel and fragments only", () => {
    expect(clean('<a href="/products/x">a</a>')).toBe('<a href="/products/x">a</a>');
    expect(clean('<a href="https://example.com/x" target="_blank">a</a>')).toBe('<a href="https://example.com/x" target="_blank" rel="noopener noreferrer">a</a>');
    expect(clean('<a href="javascript:alert(1)">a</a>')).toBe("<a>a</a>");
    expect(clean('<a href="JaVaScRiPt:alert(1)">a</a>')).toBe("<a>a</a>");
    expect(clean('<a href="//evil.com">a</a>')).toBe("<a>a</a>");
    expect(clean('<a href="/\\evil.com">a</a>')).toBe("<a>a</a>");
    expect(clean('<a href="http://example.com">a</a>')).toBe("<a>a</a>");
    expect(clean('<a href="data:text/html,x">a</a>')).toBe("<a>a</a>");
    expect(clean('<a href="mailto:a@b.co">a</a>')).toBe('<a href="mailto:a@b.co">a</a>');
  });

  it("keeps images only from https or store paths, lazily", () => {
    expect(clean('<img src="https://cdn.example.com/a.jpg" alt="A" width="40">')).toBe('<img src="https://cdn.example.com/a.jpg" alt="A" width="40" loading="lazy" decoding="async">');
    expect(clean('<img src="/cdn-cgi/image/a.jpg">')).toBe('<img src="/cdn-cgi/image/a.jpg" loading="lazy" decoding="async" alt>');
    expect(clean('<img src="http://x.com/a.jpg"><img src="data:image/png;base64,AAAA"><img src="javascript:x">')).toBe("");
    expect(clean('<img src="https://a.com/x.jpg" srcset="https://a.com/x2.jpg 2x, javascript:x 3x">')).not.toContain("srcset");
  });

  it("lets forms post only to the app's own proxy, and only with the proxy", () => {
    expect(clean('<form action="/apps/acme.wishlist/toggle" method="post"><input type="hidden" name="productId" value="p1"><button type="submit">Save</button></form>'))
      .toBe('<form action="/apps/acme.wishlist/toggle" method="post"><input type="hidden" name="productId" value="p1"><button type="submit">Save</button></form>');
    expect(clean('<form action="/apps/other.app/x" method="post"><button>Go</button></form>')).toBe('<button type="button">Go</button>');
    expect(clean('<form action="https://evil.com/steal"><input name="a"></form>')).toBe('<input name="a">');
    expect(clean('<form action="/apps/acme.wishlist/../../api/v1/x"><b>x</b></form>')).toBe("<b>x</b>");
    expect(clean('<form action="/apps/acme.wishlist/toggle"><b>x</b></form>', { forms: false })).toBe("<b>x</b>");
    expect(clean('<form action="/apps/acme.wishlist/a"><form action="/apps/acme.wishlist/b"><b>x</b></form></form>'))
      .toBe('<form action="/apps/acme.wishlist/a" method="get"><b>x</b></form>');
  });

  it("drops password, file and image inputs and the formaction attribute", () => {
    expect(clean('<form action="/apps/acme.wishlist/x"><input type="password" name="p"><input type="file" name="f"><button formaction="https://evil.com">Go</button></form>'))
      .toBe('<form action="/apps/acme.wishlist/x" method="get"><button type="button">Go</button></form>');
  });

  it("escapes attribute values and text it keeps", () => {
    // A quote can never leave the attribute; markup inside a quoted value is inert.
    expect(clean('<p title="&quot;><script>x</script>">a &lt;b&gt;</p>')).toBe('<p title="&quot;><script>x</script>">a &lt;b&gt;</p>');
  });

  it("renders nothing over its bounds", () => {
    expect(sanitizePluginHtml("x".repeat(PLUGIN_HTML_MAX_INPUT_BYTES + 1), options)).toEqual({ ok: false, reason: "too_large" });
    expect(sanitizePluginHtml("<div>".repeat(40) + "x", options)).toEqual({ ok: false, reason: "too_complex" });
    expect(sanitizePluginHtml("<b>x</b>".repeat(PLUGIN_HTML_MAX_ELEMENTS + 1), options)).toEqual({ ok: false, reason: "too_complex" });
  });

  it("checks URLs the same way for links and images", () => {
    expect(sanitizePluginUrl("/a", "image")).toBe("/a");
    expect(sanitizePluginUrl("#top", "image")).toBeNull();
    expect(sanitizePluginUrl("#top", "link")).toBe("#top");
    expect(sanitizePluginUrl("mailto:x@y.z", "image")).toBeNull();
    expect(sanitizePluginUrl("https://a.com/\u0000", "link")).toBeNull();
  });
});

describe("plugin head tags", () => {
  it("keeps meta tags the page does not own and schema.org JSON-LD", () => {
    const head = sanitizePluginHead({
      meta: [
        { name: "app-verification", content: " abc\n123 " },
        { name: "robots", content: "noindex" },
        { name: "description", content: "x" },
        { name: "og:title", content: "x" },
        { property: "og:title", content: "x" },
        { property: "product:brand", content: "Acme" },
        { name: "a", property: "b", content: "x" },
      ],
      jsonLd: [
        { "@context": "https://schema.org", "@type": "AggregateRating", ratingValue: 4.5, name: "</script><script>alert(1)</script>" },
        { "@context": "https://evil.com", "@type": "Thing" },
        { "@type": "Thing" },
      ],
    });
    expect(head.meta).toEqual([
      { attribute: "name", key: "app-verification", content: "abc 123" },
      { attribute: "property", key: "product:brand", content: "Acme" },
    ]);
    expect(head.jsonLd).toHaveLength(1);
    expect(head.jsonLd[0]).not.toContain("<");
    expect(JSON.parse(head.jsonLd[0]!)).toMatchObject({ "@type": "AggregateRating", name: "</script><script>alert(1)</script>" });
  });

  it("drops anything that is not the head shape", () => {
    expect(sanitizePluginHead("<meta>")).toEqual({ meta: [], jsonLd: [] });
    expect(sanitizePluginHead({ meta: [{ name: "x", content: "y" }], links: [] })).toEqual({ meta: [], jsonLd: [] });
  });

  it("serializes JSON-LD so it cannot close its script element", () => {
    expect(serializeJsonLd({ a: "</script>&\u2028" })).toBe('{"a":"\\u003c/script\\u003e\\u0026\\u2028"}');
  });
});

describe("proxy page answers", () => {
  it("reads pages and same-store redirects; anything else stays JSON", () => {
    expect(parsePluginPageOutput({ page: { title: "Wishlist", html: "<p>x</p>" } })).toEqual({ page: { title: "Wishlist", html: "<p>x</p>" } });
    expect(parsePluginPageOutput({ redirect: "/apps/acme.wishlist/wishlist" })).toEqual({ redirect: "/apps/acme.wishlist/wishlist" });
    expect(parsePluginPageOutput({ redirect: "//evil.com" })).toBeNull();
    expect(parsePluginPageOutput({ redirect: "https://evil.com" })).toBeNull();
    expect(parsePluginPageOutput({ redirect: "/\\evil.com" })).toBeNull();
    expect(parsePluginPageOutput({ items: [] })).toBeNull();
    expect(parsePluginPageOutput(null)).toBeNull();
  });
});
