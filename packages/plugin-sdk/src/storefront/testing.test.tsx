/** @jsxImportSource @scalius/plugin-sdk/storefront */
import { describe, expect, it } from "vitest";
import { BuyForm, Reviews, Toolbar } from "./components";
import { defineStorefront, type BlockProps, type ListingMainProps, type ProductMainProps, type SectionSkinProps } from "./define";
import { raw } from "./html";
import { assertHeaderContract, checkSkinHtml, fixtureProductPage, fixtureSectionSkinData, renderBlock, renderHeader, renderSkin } from "./testing";

describe("header render assertions", () => {
  it("identifies the failing component and its markup error", () => {
    const module = defineStorefront({ skins: { masthead: () => raw('<header id="menu"><nav id="menu"></nav></header>') } });
    expect(() => renderHeader(module, "masthead")).toThrow('Skin "masthead" (header): Invalid header markup: Duplicate id "menu"');
  });

  it("checks explicit island declarations without requiring optional header features", () => {
    const module = defineStorefront({ skins: {
      campaign: () => raw('<a href="/">Shop</a>'),
      menu: () => raw('<scalius-island data-island="menu"></scalius-island>'),
    } });
    expect(renderHeader(module, "campaign", {}, {}, { islands: [] })).toBe('<a href="/">Shop</a>');
    expect(() => renderHeader(module, "menu", {}, {}, { islands: [] })).toThrow('Island "menu" is not declared');
    expect(() => renderHeader(module, "menu", {}, {}, { islands: ["menu"] })).not.toThrow();
    expect(() => assertHeaderContract('<header data-sticky-header>Shop</header>')).not.toThrow();
  });
});

describe("skins and blocks", () => {
  const app = defineStorefront({
    skins: {
      pdp: ({ data }: ProductMainProps) => (
        <article class="pdp"><h1>{data.product.title}</h1><BuyForm title={false} /><Reviews /></article>
      ),
      broken: ({ data }: ProductMainProps) => <article><h1>{data.product.title}</h1></article>,
      grid: ({ data }: ListingMainProps) => (
        <section><Toolbar /><ul>{data.cards.map((card) => <li>{card.title}</li>)}</ul></section>
      ),
      hero: ({ data, instanceId }: SectionSkinProps<"hero">) => (
        <section id={`acme-${instanceId}`}>{data.settings.slides.map((slide) => <p>{slide.alt}</p>)}</section>
      ),
    },
    blocks: {
      guide: ({ data, target }: BlockProps) => <aside data-target={target}>{data.product.options.map((option) => option.name).join(", ")}</aside>,
    },
  });

  it("renders a product-main skin over the fixture page and holds it to one buy form", () => {
    expect(renderSkin(app, "pdp", "product-main")).toBe('<article class="pdp"><h1>Linen shirt</h1><scalius-embed kind="buy-form" data-title="false"></scalius-embed><scalius-embed kind="reviews"></scalius-embed></article>');
    expect(() => renderSkin(app, "broken", "product-main")).toThrow(/must place <scalius-embed kind="buy-form">/);
  });

  it("renders listing and section skins and component blocks", () => {
    expect(renderSkin(app, "grid", "listing-main")).toBe('<section><scalius-embed kind="toolbar"></scalius-embed><ul><li>Linen shirt</li><li>Oxford shirt</li></ul></section>');
    expect(renderSkin(app, "hero", "section:hero", {}, fixtureSectionSkinData("hero", { slides: [{ alt: "Eid sale" }] }))).toBe('<section id="acme-hero"><p>Eid sale</p></section>');
    expect(renderBlock(app, "guide", {}, fixtureProductPage(), { target: "product.buy-box" })).toBe('<aside data-target="product.buy-box">Size</aside>');
    expect(checkSkinHtml("header", '<scalius-embed kind="filters"></scalius-embed>')).toEqual(["1 embed(s) render nothing here: header allows none."]);
  });
});
