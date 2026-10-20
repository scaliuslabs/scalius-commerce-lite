import { describe, expect, it } from "vitest";
import { Parser } from "htmlparser2";
import { sanitizePluginHtml, sanitizePluginUrl } from "./html";
import { parsePluginPageOutput, sanitizePluginHead, serializeJsonLd } from "./storefront";
import { STOREFRONT_COMPONENT_LIMITS } from "./storefront-protocol";

/** An app page's markup: forms post only to the app's own routes. */
const options = { pluginId: "acme.wishlist", formsTo: "/apps/acme.wishlist/" };
function clean(html: string): string {
  const result = sanitizePluginHtml(html, options);
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return result.html;
}

describe("plugin storefront HTML", () => {
  it("keeps content markup and plain text", () => {
    expect(clean('<section class="grid gap-2"><h2>Saved</h2><p>Hello <strong>you</strong> &amp; them</p><ul><li>One</li></ul></section>'))
      .toBe('<section class="grid gap-2"><h2>Saved</h2><p>Hello <strong>you</strong> &amp; them</p><ul><li>One</li></ul></section>');
  });

  it("drops scripts, styles, iframes and templates with their content, and event handlers", () => {
    expect(clean('<div onclick="x()">a<script>alert(1)</script><style>body{}</style><iframe src="https://x.com"></iframe><template><b>t</b></template><noscript>n</noscript>b</div>')).toBe("<div>ab</div>");
  });

  it("allows links to store paths, https, mailto, tel and fragments only", () => {
    expect(clean('<a href="/products/x">a</a>')).toBe('<a href="/products/x">a</a>');
    expect(clean('<a href="https://example.com/x" target="_blank">a</a>')).toBe('<a href="https://example.com/x" target="_blank" rel="noopener noreferrer">a</a>');
    expect(clean('<a href="javascript:alert(1)">a</a>')).toBe("<a>a</a>");
    expect(clean('<a href="JaVaScRiPt:alert(1)">a</a>')).toBe("<a>a</a>");
    expect(clean('<a href="//evil.com">a</a>')).toBe("<a>a</a>");
    expect(clean('<a href="/\\evil.com">a</a>')).toBe("<a>a</a>");
    expect(clean('<a href="data:text/html,x">a</a>')).toBe("<a>a</a>");
    expect(clean('<a href="mailto:a@b.co">a</a>')).toBe('<a href="mailto:a@b.co">a</a>');
  });

  it("keeps images only from http(s) or store paths", () => {
    expect(clean('<img src="data:image/png;base64,AAAA"><img src="javascript:x">')).toBe("");
    expect(clean('<img src="https://a.com/x.jpg" srcset="https://a.com/x2.jpg 2x, javascript:x 3x">')).not.toContain("srcset");
  });

  it("lets an app page's forms post only to the app's own routes", () => {
    expect(clean('<form action="/apps/acme.wishlist/toggle" method="post"><input type="hidden" name="productId" value="p1"><button type="submit">Save</button></form>'))
      .toBe('<form action="/apps/acme.wishlist/toggle" method="post"><input type="hidden" name="productId" value="p1"><button type="submit">Save</button></form>');
    expect(clean('<form action="/apps/other.app/x" method="post"><button>Go</button></form>')).toBe('<button type="button">Go</button>');
    expect(clean('<form action="/cart/add" method="post"><button>Go</button></form>')).toBe('<button type="button">Go</button>');
    expect(clean('<form action="https://evil.com/steal"><input name="a"></form>')).toBe('<input name="a">');
    expect(clean('<form action="/apps/acme.wishlist/../../api/v1/x"><b>x</b></form>')).toBe("<b>x</b>");
    expect(clean('<form action="/apps/acme.wishlist/a"><form action="/apps/acme.wishlist/b"><b>x</b></form></form>'))
      .toBe('<form action="/apps/acme.wishlist/a" method="get"><b>x</b></form>');
  });

  it("drops password, file and image inputs and the formaction attribute", () => {
    expect(clean('<form action="/apps/acme.wishlist/x"><input type="password" name="p"><input type="file" name="f"><button formaction="https://evil.com">Go</button></form>'))
      .toBe('<form action="/apps/acme.wishlist/x" method="get"><button type="button">Go</button></form>');
  });

  it("escapes attribute values and text it keeps", () => {
    // Nothing can leave a quoted value, and no raw-text parent (noscript) can end inside one.
    expect(clean('<p title="&quot;><script>x</script>">a &lt;b&gt;</p>')).toBe('<p title="&quot;&gt;&lt;script&gt;x&lt;/script&gt;">a &lt;b&gt;</p>');
  });

  it("checks URLs the same way for links and images", () => {
    expect(sanitizePluginUrl("/a", "image")).toBe("/a");
    expect(sanitizePluginUrl("#top", "image")).toBeNull();
    expect(sanitizePluginUrl("#top", "link")).toBe("#top");
    expect(sanitizePluginUrl("mailto:x@y.z", "image")).toBeNull();
    expect(sanitizePluginUrl("https://a.com/\u0000", "link")).toBeNull();
  });
});

describe("app component HTML", () => {
  const component = (html: string, jsonLd = true) => {
    const result = sanitizePluginHtml(html, { pluginId: "acme.theme", jsonLd });
    if (!result.ok) throw new Error(`refused: ${result.reason}`);
    return result;
  };
  const shown = (html: string, jsonLd = true) => component(html, jsonLd).html;

  it("keeps what a theme draws with, as written", () => {
    const html = '<section class="theme-s" style="--theme-cols:4;grid-template-columns:repeat(var(--theme-cols), minmax(0, 1fr))">'
      + '<h1 data-theme-field="heading">Hi</h1>'
      + '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M4 7h16"></path><circle cx="11" cy="11" r="7"></circle><rect x="3" y="5" width="18" height="14" rx="2"></rect></svg>'
      + '<button type="button" popovertarget="theme-menu" aria-label="Menu">=</button><div id="theme-menu" popover="auto" tabindex="-1">m</div>'
      + '<form action="/search" method="get" role="search"><input type="search" name="q" autofocus></form>'
      + '<scalius-island data-island="rail" data-hydrate="visible" data-props="{&quot;a&quot;:1}"><ul data-track></ul></scalius-island>'
      + '<scalius-embed kind="order-form" data-product="prod_1" data-max-quantity="5"></scalius-embed><scalius-embed kind="buy-form" data-title="false"></scalius-embed>'
      + '<video class="cover" src="https://media.example.com/film.mp4" poster="/media/poster.webp" preload="none" muted loop playsinline></video>'
      + '<img src="https://media.example.com/a.webp" srcset="https://media.example.com/a-600.webp 600w" sizes="100vw" alt="A" width="1200" height="800" loading="eager" fetchpriority="high" decoding="sync">'
      + '</section>';
    const result = component(html);
    expect(result.html).toBe(html);
    expect(result.dropped).toBe(0);
  });

  it("keeps the camel case SVG needs, and self-closed SVG elements stay siblings", () => {
    expect(shown('<svg viewBox="0 0 2 2"><linearGradient id="theme-g"><stop offset="0" stop-color="#fff"/></linearGradient><path d="M0 0"/><rect fill="url(#theme-g)"/></svg>'))
      .toBe('<svg viewBox="0 0 2 2"><linearGradient id="theme-g"><stop offset="0" stop-color="#fff"></stop></linearGradient><path d="M0 0"></path><rect fill="url(#theme-g)"></rect></svg>');
  });

  it("keeps ids only under the app's own prefix, and never host attributes", () => {
    expect(shown('<div id="checkout-config" data-sx-base="/_x/other.app/0/" data-sx-app="other.app" data-tone="ink">x</div>')).toBe('<div data-tone="ink">x</div>');
    expect(shown('<p id="theme-a">x</p><p name="x">y</p>')).toBe('<p id="theme-a">x</p><p>y</p>');
  });

  it("keeps style that loads and hides nothing", () => {
    expect(shown('<p style="left: 50%; top: calc(100% - 4px)">a</p>')).toBe('<p style="left:50%;top:calc(100% - 4px)">a</p>');
    for (const style of [
      "background:url(https://evil.test/x)", "background:u\\72l(https://evil.test/x)", "x:expression(alert(1))",
      "background-image:image-set('x.png' 1x)", "color:red/**/", "--x:attr(data-x)", "@import 'x'", "color:red}body{color:blue",
    ]) expect(shown(`<p style="${style}">a</p>`), style).toBe("<p>a</p>");
  });

  it("keeps schema.org JSON-LD re-serialized, and none on a noindex page", () => {
    const script = '<script type="application/ld+json">{"@context":"https://schema.org","@type":"FAQPage","text":"<b>"}</script>';
    expect(shown(script)).toBe('<script type="application/ld+json">{"@context":"https://schema.org","@type":"FAQPage","text":"\\u003cb\\u003e"}</script>');
    expect(shown(script, false)).toBe("");
    expect(shown('<script type="application/ld+json">{"@context":"https://evil.test","@type":"Thing"}</script>')).toBe("");
    expect(shown('<script type="application/ld+json">not json</script>')).toBe("");
  });

  it("lets forms post to store paths only", () => {
    expect(shown('<form action="/newsletter" method="post"><input type="email" name="email"></form>')).toBe('<form action="/newsletter" method="post"><input type="email" name="email"></form>');
    expect(shown('<form action="https://evil.test/"><input name="q"></form>')).toBe('<input name="q">');
    expect(shown('<form action="//evil.test/"><b>x</b></form>')).toBe("<b>x</b>");
  });

  // Parser-differential (mXSS) vectors: each must come out with no script,
  // handler, script URL, raw-text element or markup in a value, and sanitize
  // to itself again.
  const RAW_TEXT = new Set(["script", "style", "noscript", "template", "title", "xmp", "iframe", "noembed", "noframes", "plaintext", "math", "foreignobject", "animate", "set", "use", "object", "embed", "base", "meta", "link"]);
  // Whitespace and C0 controls are dropped before the scheme check, the way a URL parser ignores them.
  const withoutBlanksAndControls = (value: string) => [...value].filter((char) => char.charCodeAt(0) > 0x1f && !/\s/.test(char)).join("");
  function issuesOf(html: string): string[] {
    const issues: string[] = [];
    const parser = new Parser({
      onopentag(name, attributes) {
        if (RAW_TEXT.has(name) && !(name === "script" && attributes.type === "application/ld+json")) issues.push(`<${name}>`);
        for (const [key, value] of Object.entries(attributes)) {
          if (key.startsWith("on") || key === "srcdoc" || key === "formaction" || (key.includes("href") && key !== "href")) issues.push(key);
          if (/^(?:javascript|vbscript|data):/i.test(withoutBlanksAndControls(value))) issues.push(`${key}=${value}`);
        }
      },
      ontext(text) {
        if (text.includes("<")) issues.push(`text ${text}`);
      },
    }, { decodeEntities: false });
    parser.write(html);
    parser.end();
    if (/="[^"]*[<>]/.test(html)) issues.push("markup in an attribute value");
    return issues;
  }

  it.each([
    // The two bypasses of the former blocklist sanitizer (each made a real <img onerror> in Chrome).
    ["noscript/style", "<noscript><style></noscript><img src=x onerror=alert(1)></style></noscript>"],
    ["svg/style entity", "<svg><style>&lt;img src=x onerror=alert(1)&gt;</style></svg>"],
    ["svg animate href", '<svg><a><animate attributeName="href" values="javascript:alert(1)"/><text>x</text></a></svg>'],
    ["math mglyph style", "<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>"],
    ["form math namespace", "<form><math><mtext></form><form><mglyph><style></math><img src onerror=alert(1)>"],
    ["svg p style breakout", '<svg></p><style><a id="</style><img src=1 onerror=alert(1)>">'],
    ["template style", "<template><style></template><img src=x onerror=alert(1)></style></template>"],
    ["textarea", "<textarea><img src=x onerror=alert(1)></textarea>"],
    ["title", "<title><img src=x onerror=alert(1)></title>"],
    ["xmp", "<xmp><img src=x onerror=alert(1)></xmp>"],
    ["noscript attribute", '<noscript><p title="</noscript><img src=x onerror=alert(1)>"></p></noscript>'],
    ["attribute that closes noscript", '<p title="</noscript><img src=x onerror=alert(1)>">x</p>'],
    ["svg CDATA", "<svg><![CDATA[</svg><img src=x onerror=alert(1)>]]></svg>"],
    ["comments", "<!--<img src=x onerror=alert(1)>--><!--><img src=x onerror=alert(2)>-->"],
    ["foreignObject", "<svg><foreignObject><img src=x onerror=alert(1)></foreignObject></svg>"],
    ["svg use", '<svg><use href="data:image/svg+xml;base64,PHN2Zz4="></use></svg>'],
    ["svg xlink", '<svg><a xlink:href="javascript:alert(1)"><rect width="1"/></a></svg>'],
    ["svg paint url", '<svg><rect fill="url(https://evil.test/x)"/></svg>'],
    ["iframe srcdoc", '<iframe srcdoc="<script>alert(1)</script>"></iframe>'],
    ["entity schemes", '<a href="jav&#x09;ascript:alert(1)">a</a><a href="&#106;avascript:alert(1)">b</a>'],
    ["image schemes", '<img src="javascript:alert(1)"><img srcset="javascript:alert(1) 1x" src="/a.png"><video poster="javascript:alert(1)" src="http://evil.test/v.mp4"></video>'],
    ["formaction", '<form action="/search"><button formaction="javascript:alert(1)">go</button></form>'],
    ["head tags", '<meta http-equiv="refresh" content="0;url=javascript:alert(1)"><base href="https://evil.test/"><link rel="stylesheet" href="https://evil.test/x.css">'],
    ["object embed", '<object data="javascript:alert(1)"></object><embed src="javascript:alert(1)">'],
    ["island handler", '<scalius-island data-island="x" onload="alert(1)">x</scalius-island>'],
    ["JSON-LD that closes its script", '<script type="application/ld+json">{"@context":"https://schema.org","@type":"Thing","name":"</script><script>alert(1)</script>"}</script>'],
    ["math href", '<math href="javascript:alert(1)">x</math>'],
  ])("is inert after a parser-differential vector: %s", (_name, input) => {
    const once = shown(input);
    expect(issuesOf(once)).toEqual([]);
    expect(shown(once)).toBe(once);
  });

  it("refuses markup over its bounds", () => {
    const options = { pluginId: "acme.theme" };
    expect(sanitizePluginHtml("x".repeat(STOREFRONT_COMPONENT_LIMITS.htmlBytes + 1), options)).toEqual({ ok: false, reason: "too_large" });
    expect(sanitizePluginHtml("<div>".repeat(STOREFRONT_COMPONENT_LIMITS.htmlDepth + 1), options)).toEqual({ ok: false, reason: "too_complex" });
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
    expect(parsePluginPageOutput({ page: { title: "Wishlist", component: "wishlist_page", props: { items: [] } } })).toEqual({ page: { title: "Wishlist", component: "wishlist_page", props: { items: [] } } });
    expect(parsePluginPageOutput({ page: { title: "Wishlist", component: "wishlist_page" } })).toEqual({ page: { title: "Wishlist", component: "wishlist_page", props: {} } });
    // Raw HTML is gone: a page names its component.
    expect(parsePluginPageOutput({ page: { title: "Wishlist", html: "<p>x</p>" } })).toBeNull();
    expect(parsePluginPageOutput({ page: { title: "Big", component: "p", props: { text: "x".repeat(70 * 1024) } } })).toBeNull();
    expect(parsePluginPageOutput({ redirect: "/apps/acme.wishlist/wishlist" })).toEqual({ redirect: "/apps/acme.wishlist/wishlist" });
    expect(parsePluginPageOutput({ redirect: "//evil.com" })).toBeNull();
    expect(parsePluginPageOutput({ redirect: "https://evil.com" })).toBeNull();
    expect(parsePluginPageOutput({ redirect: "/\\evil.com" })).toBeNull();
    expect(parsePluginPageOutput({ items: [] })).toBeNull();
    expect(parsePluginPageOutput(null)).toBeNull();
  });
});
