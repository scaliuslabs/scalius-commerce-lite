import { describe, expect, it } from "vitest";
import { isSafeStorefrontUrl, sanitizeStorefrontHtml } from "./storefront-html";

const clean = (html: string) => sanitizeStorefrontHtml(html).html;

describe("sanitizeStorefrontHtml", () => {
  it("keeps markup, classes, inline styles, SVG, forms, popovers and custom elements as written", () => {
    const html = `<section class="a" style="--x:1;color:red"><svg viewBox="0 0 24 24"><path d="M1 1"/></svg><form action="/search" method="get"><input name="q" autofocus></form><button popovertarget="m">Menu</button><div id="m" popover="auto">x</div><scalius-island data-island="carousel" data-props="{&quot;a&quot;:1}"><p>Slides</p></scalius-island></section>`;
    expect(clean(html)).toBe(html.replace("<path d=\"M1 1\"/>", "<path d=\"M1 1\"></path>"));
  });

  it("drops script, event handlers and script-capable URLs", () => {
    const result = sanitizeStorefrontHtml(`<div onclick="x()"><script>alert(1)</script><a href="javascript:alert(1)">a</a><a href="jav&#x09;ascript:alert(1)">b</a><img src="x" onerror="y()"><iframe srcdoc="<b>"></iframe><object data="x"></object></div>`);
    expect(result.html).toBe(`<div><a>a</a><a>b</a><img src="x"></div>`);
    expect(result.dropped).toBeGreaterThanOrEqual(6);
  });

  it("keeps https iframes (lazily) and JSON-LD, re-serialized", () => {
    expect(clean(`<iframe src="https://www.youtube.com/embed/x"></iframe>`)).toBe(`<iframe src="https://www.youtube.com/embed/x" loading="lazy"></iframe>`);
    expect(clean(`<iframe src="http://x.test"></iframe>`)).toBe("");
    expect(clean(`<script type="application/ld+json">{"a":"</script>"}</script>`)).not.toContain("</script>\"");
    expect(clean(`<script type="application/ld+json">{"@type":"FAQPage","text":"<b>"}</script>`)).toBe(`<script type="application/ld+json">{"@type":"FAQPage","text":"\\u003cb\\u003e"}</script>`);
    expect(clean(`<script type="application/ld+json">not json</script>`)).toBe("");
  });

  it("drops CSS that can run or load code, keeps the rest", () => {
    expect(clean(`<style>.a{color:red}</style>`)).toBe(`<style>.a{color:red}</style>`);
    expect(clean(`<style>@import url(https://x.test/a.css);</style>`)).toBe(`<style></style>`);
    expect(clean(`<p style="background:url(javascript:x)">a</p>`)).toBe(`<p>a</p>`);
  });

  it("re-escapes text and closes what the input left open", () => {
    expect(clean(`<p>a &amp; b < c</p>`)).toBe(`<p>a &amp; b &lt; c</p>`);
    expect(clean(`<div><a href="/x">open`)).toBe(`<div><a href="/x">open</a></div>`);
  });

  it("judges URLs by scheme, ignoring the tricks that hide one", () => {
    expect(isSafeStorefrontUrl("/products/x")).toBe(true);
    expect(isSafeStorefrontUrl("#order")).toBe(true);
    expect(isSafeStorefrontUrl("https://a.test")).toBe(true);
    expect(isSafeStorefrontUrl("tel:+880")).toBe(true);
    expect(isSafeStorefrontUrl(" JAVASCRIPT:x")).toBe(false);
    expect(isSafeStorefrontUrl("java\nscript:x")).toBe(false);
    expect(isSafeStorefrontUrl("data:text/html,x")).toBe(false);
  });
});
