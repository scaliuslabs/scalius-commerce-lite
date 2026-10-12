import { describe, expect, it } from "vitest";
import { checkStorefrontHeaderHtml } from "./storefront-html-check";

describe("header author diagnostics", () => {
  it("accepts a logo-only campaign header and leaves layout to the author", () => {
    expect(checkStorefrontHeaderHtml('<header><a href="/">Campaign</a></header>', { islands: [] })).toEqual([]);
    expect(checkStorefrontHeaderHtml('<div data-sticky-header><div data-sticky-header>Header</div></div>')).toEqual([]);
  });

  it("finds duplicate IDs after HTML entity decoding, without treating comments or CSS as elements", () => {
    expect(checkStorefrontHeaderHtml('<header id="menu"><div ID="m&#101;nu"></div></header>')).toEqual([
      'Duplicate id "menu": give each header element a unique id.',
    ]);
    expect(checkStorefrontHeaderHtml('<header id="menu"><!-- <div id="menu"> --><style>.x::before{content:\'<a id="menu">\'}</style></header>')).toEqual([]);
  });

  it("does not count inert template content against the live header's IDs or island declarations", () => {
    expect(checkStorefrontHeaderHtml('<header id="menu"><template><div id="menu"></div><template><scalius-island data-island="later"></scalius-island></template></template><a id="other">Link</a></header>', { islands: [] })).toEqual([]);
    expect(checkStorefrontHeaderHtml('<template><span id="menu"></span></template><div id="menu"></div><span id="menu"></span>')).toHaveLength(1);
  });

  it("accepts native and custom action controls, wrappers and their SVG icons", () => {
    expect(checkStorefrontHeaderHtml(`
      <button type="button" data-search-open><svg><path d="M0 0"></path></svg></button>
      <a data-account-link href="/bd/account">Account</a>
      <a data-cart-open href="/cart?view=drawer">Cart</a>
      <div role="button" tabindex="0" data-search-open>Search</div>
      <div data-search-open><button>Search</button></div>
      <form data-header-search action="/search"><input name="q" data-search-inline><select data-search-scope></select></form>
    `)).toEqual([]);
  });

  it("names an invalid declared form or unsafe host-action fallback", () => {
    expect(checkStorefrontHeaderHtml('<div data-header-search><input name="q"></div>')).toEqual([
      "data-header-search belongs on <form>, not <div>; the host listens for that form's submit event.",
    ]);
    expect(checkStorefrontHeaderHtml('<a data-account-link href="jav&#x09;ascript:alert(1)">Account</a>')).toEqual([
      "data-account-link has an unsafe href; use a safe fallback URL such as the supplied data.routes path.",
    ]);
  });

  it.each(["template", "style", "script", "meta"])("rejects a sticky marker on non-rendered <%s>", (tag) => {
    expect(checkStorefrontHeaderHtml(`<${tag} data-sticky-header></${tag}>`)).toEqual([
      `data-sticky-header on <${tag}> cannot mark a rendered box; move it to the element that sticks.`,
    ]);
  });

  it("checks island declarations only when supplied and allows the default hydration", () => {
    const html = '<scalius-island data-island="menu"><button>Menu</button></scalius-island>';
    expect(checkStorefrontHeaderHtml(html)).toEqual([]);
    expect(checkStorefrontHeaderHtml(html, { islands: ["menu"] })).toEqual([]);
    expect(checkStorefrontHeaderHtml(html, { islands: [] })).toEqual([
      'Island "menu" is not declared in storefront.islands; declare it and provide src/islands/menu.ts.',
    ]);
  });

  it("explains missing island names and unsupported hydration", () => {
    expect(checkStorefrontHeaderHtml('<scalius-island data-hydrate="hover"></scalius-island>')).toEqual([
      "scalius-island needs a valid data-island name (lowercase letters, digits and hyphens, starting with a letter).",
      'Island "" has invalid data-hydrate "hover"; use load, idle, visible, interaction.',
    ]);
    for (const hydrate of ["load", "idle", "visible", "interaction"]) {
      expect(checkStorefrontHeaderHtml(`<scalius-island data-island="menu" data-hydrate="${hydrate}"></scalius-island>`)).toEqual([]);
    }
  });
});
