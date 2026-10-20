/** @jsxImportSource @scalius/plugin-sdk/storefront */
import { describe, expect, it } from "vitest";
import { BuyForm, Reviews, Slot, Toolbar } from "./components";
import { defineStorefront, type ComponentProps, type ListingMainProps, type ProductMainProps, type SectionSkinProps } from "./define";
import { raw } from "./html";
import { assertHeaderContract, checkSkinHtml, fixtureProductPage, fixtureSectionSkinData, renderComponent, renderHeader, renderSkin } from "./testing";

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
    components: {
      guide: (props: ComponentProps) => props.target.startsWith("product.") && "data" in props
        ? <aside data-target={props.target}>{props.data.product.options.map((option) => option.name).join(", ")}</aside>
        : <span data-target={props.target}>Guide</span>,
      vendor: (props: ComponentProps<Record<string, never>, { name: string }>) => props.target === "page" ? <h2>{props.props.name}</h2> : null,
      nested: () => <div><Slot name="header.actions" /></div>,
    },
  });

  it("renders a product-main skin over the fixture page and holds it to one buy form", () => {
    expect(renderSkin(app, "pdp", "product-main")).toBe('<article class="pdp"><h1>Linen shirt</h1><scalius-embed kind="buy-form" data-title="false"></scalius-embed><scalius-embed kind="reviews"></scalius-embed></article>');
    expect(() => renderSkin(app, "broken", "product-main")).toThrow(/must place <scalius-embed kind="buy-form">/);
  });

  it("renders listing and section skins and component blocks", () => {
    expect(renderSkin(app, "grid", "listing-main")).toBe('<section><scalius-embed kind="toolbar"></scalius-embed><ul><li>Linen shirt</li><li>Oxford shirt</li></ul></section>');
    expect(renderSkin(app, "hero", "section:hero", {}, fixtureSectionSkinData("hero", { slides: [{ alt: "Eid sale" }] }))).toBe('<section id="acme-hero"><p>Eid sale</p></section>');
    expect(renderComponent(app, "guide", "product.buy_box.after", {}, { data: fixtureProductPage() })).toBe('<aside data-target="product.buy_box.after">Size</aside>');
    expect(renderComponent(app, "guide", "header.actions")).toBe('<span data-target="header.actions">Guide</span>');
    expect(checkSkinHtml("header", '<scalius-embed kind="filters"></scalius-embed>')).toEqual(["1 embed(s) render nothing here: header allows slot."]);
    expect(checkSkinHtml("header", '<scalius-embed kind="slot" data-name="header.actions"></scalius-embed>')).toEqual([]);
  });

  it("renders a page component with the route's props escaped, and refuses slots inside a component", () => {
    expect(renderComponent(app, "vendor", "page", {}, { props: { name: "<img src=x onerror=alert(1)>" } }))
      .toBe("<h2>&lt;img src=x onerror=alert(1)&gt;</h2>");
    expect(() => renderComponent(app, "nested", "footer.columns")).toThrow(/render nothing in a component/);
  });
});
