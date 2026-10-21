/** @jsxImportSource @scalius/plugin-sdk/storefront */
import { describe, expect, it } from "vitest";
import { BuyForm, Reviews, Slot, Toolbar } from "./components";
import { componentFor, defineStorefront, type ComponentProps, type ComponentPropsFor, type ListingMainProps, type ProductMainProps, type SectionSkinProps } from "./define";
import { raw } from "./html";
import { STOREFRONT_SECTION_SKIN_PROJECTIONS, type StorefrontSkinnableSection } from "@scalius/shared/plugins/storefront-protocol";
import { assertHeaderContract, checkSkinHtml, fixtureProductPage, fixtureSectionSkinData, fixtureSkinData, renderComponent, renderHeader, renderSkin } from "./testing";

describe("section skin fixtures follow the sealed projection", () => {
  it("lets a skin read a field its type says is always there", () => {
    // A usp_strip projection always carries its source (a delivery-facts strip by default).
    const strip = defineStorefront({ skins: {
      bold: ({ data }: SectionSkinProps<"usp_strip">) => (
        <ul data-kind={data.settings.source.kind}>{data.settings.source.items.map((item) => <li>{item.title}</li>)}</ul>
      ),
    } });
    expect(renderSkin(strip, "bold", "section:usp_strip")).toBe('<ul data-kind="delivery-facts"><li>Delivery in Dhaka</li><li>Cash on delivery</li></ul>');
  });

  it("builds every skinnable section from core's defaults, at its projection version", () => {
    for (const type of Object.keys(STOREFRONT_SECTION_SKIN_PROJECTIONS) as StorefrontSkinnableSection[]) {
      const data = fixtureSectionSkinData(type);
      expect(data).toMatchObject({ type, version: STOREFRONT_SECTION_SKIN_PROJECTIONS[type] });
      expect(Object.keys(data.settings as object).length, type).toBeGreaterThan(0);
      expect(fixtureSkinData(`section:${type}`)).toEqual(data);
    }
    expect(fixtureSectionSkinData("product_rail").settings.products.cards).toHaveLength(2);
    expect(fixtureSectionSkinData("brand_wall").tiles).toHaveLength(1);
    expect(() => fixtureSectionSkinData("recently_viewed" as StorefrontSkinnableSection)).toThrow(/not a core section a skin can draw/);
  });
});

describe("component props by target", () => {
  it("types a component's props by the targets it lists, and refuses any other target", () => {
    const app = defineStorefront({ components: {
      badge: componentFor(["product_card.badges"], ({ data, settings }) => <b>{data.product.title}{String(settings.suffix ?? "")}</b>),
      guide: componentFor(["product.buy_box.after", "product.below"], (props) => <aside data-id={props.instanceId}>{props.data.product.title}</aside>),
      // The union narrows by target without a cast.
      any: (props: ComponentProps) => {
        switch (props.target) {
          case "product.below": return <p>{props.data.product.title}</p>;
          case "product_card.meta": return <p>{props.data.product.title}</p>;
          case "page": return <h2>{String(props.props.name)}</h2>;
          default: return <span>{props.target}</span>;
        }
      },
    } });
    expect(renderComponent(app, "badge", "product_card.badges", { suffix: "!" }, { data: fixtureSkinData("product_card") })).toBe("<b>Linen shirt!</b>");
    expect(renderComponent(app, "guide", "product.below", {}, { data: fixtureProductPage() })).toContain("Linen shirt");
    expect(() => renderComponent(app, "guide", "header.actions")).toThrow("This component draws at product.buy_box.after, product.below, not header.actions.");
    expect(renderComponent(app, "any", "page", {}, { props: { name: "Vendors" } })).toBe("<h2>Vendors</h2>");
    expect(renderComponent(app, "any", "footer.columns")).toBe("<span>footer.columns</span>");
    const layout: ComponentPropsFor<"header.actions"> = { target: "header.actions", settings: {}, context: {} as never };
    // @ts-expect-error a layout slot has no product page
    void layout.data;
  });
});

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

describe("skins and components", () => {
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
      guide: (props: ComponentProps) => "instanceId" in props
        ? <aside data-target={props.target}>{props.data.product.options.map((option) => option.name).join(", ")}</aside>
        : <span data-target={props.target}>Guide</span>,
      vendor: (props: ComponentProps<Record<string, never>, { name: string }>) => props.target === "page" ? <h2>{props.props.name}</h2> : null,
      nested: () => <div><Slot name="header.actions" /></div>,
    },
  });

  it("renders a product_main skin over the fixture page and holds it to one buy form", () => {
    expect(renderSkin(app, "pdp", "product_main")).toBe('<article class="pdp"><h1>Linen shirt</h1><scalius-embed kind="buy_form" data-title="false"></scalius-embed><scalius-embed kind="reviews"></scalius-embed></article>');
    expect(() => renderSkin(app, "broken", "product_main")).toThrow(/must place <scalius-embed kind="buy_form">/);
  });

  it("renders listing and section skins and components", () => {
    expect(renderSkin(app, "grid", "listing_main")).toBe('<section><scalius-embed kind="toolbar"></scalius-embed><ul><li>Linen shirt</li><li>Oxford shirt</li></ul></section>');
    expect(renderSkin(app, "hero", "section:hero", {}, fixtureSectionSkinData("hero", { slides: [{ image: null, focalPoint: { x: 50, y: 50 }, alt: "Eid sale", link: null }] }))).toBe('<section id="acme-hero"><p>Eid sale</p></section>');
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
