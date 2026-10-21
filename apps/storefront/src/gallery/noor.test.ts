// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { readStorefrontExtensions, resolveStorefrontSettings, storefrontExtensionBase } from "@scalius/shared/plugins/storefront-components";
import { BUNDLED_STOREFRONT_EXTENSIONS } from "../extensions/bundled.gen";
import { clearExtensionMemo, ExtensionHost } from "../lib/extensions/host";
import { serveExtensionFile } from "../lib/extensions/files";
import { readHomepageAppSurfaces } from "../lib/app-surfaces";
import { answerFixtureApi, galleryApiBase, galleryNavigation } from "./api";
import { galleryEntry } from "./entries";
import { galleryRenderPlan } from "./server";
import { NOOR_EXTENSION } from "./noor";
import { galleryEntries } from "./entries";
import { NOOR_SECTION_FIXTURES, NOOR_REPEATED_FIXTURES } from "./noor-content";
import { validatePluginSettingValues } from "@scalius/shared/plugins/settings-schema";
import { componentSectionSettings, productCardData, storefrontImageOf } from "../lib/extensions/data";
import { productCardModel, type ProductCardProduct } from "../components/cards/card-model";

const origin = "http://127.0.0.1:4799";
async function read(id: string, path: string) {
  const entry = galleryEntry(id)!;
  const response = await answerFixtureApi(entry, new Request(`${galleryApiBase(origin, id)}/api/v1/${path}`));
  expect(response.status).toBe(200);
  return (await response.json() as { data: Record<string, unknown> }).data;
}
afterEach(clearExtensionMemo);

describe("packed Noor gallery integration", () => {
  it("covers every registered Noor section with real host fixtures and scoped visible subjects", () => {
    const entries = galleryEntries().filter((entry) => entry.scenario.noor === "active");
    const types = new Set(entries.flatMap((entry) => [
      ...entry.theme.pages.home,
      ...Object.values(entry.theme.pages.landing ?? {}).flatMap((page) => page.sections),
    ]).flatMap((section) => section.type === "app" ? [section.settings.app.slice("scalius.noor/".length)] : []));
    expect(NOOR_EXTENSION.sections.filter((type) => !types.has(type))).toEqual([]);
    for (const type of Object.keys(NOOR_SECTION_FIXTURES)) {
      expect(galleryEntry(`noor-section-${type}-default`)?.focus.include).toEqual([`[data-section-id="noor-section-${type}-default"] ${NOOR_SECTION_FIXTURES[type as keyof typeof NOOR_SECTION_FIXTURES].subject}`]);
    }
    for (const { type, field, max } of NOOR_REPEATED_FIXTURES) {
      for (const [variant, count] of [["one", 1], ["crowded", max]] as const) {
        const section = galleryEntry(`noor-section-${type}-${variant}`)!.theme.pages.home[0]!;
        expect(section.type).toBe("app");
        if (section.type === "app") expect(section.settings.values[field]).toHaveLength(count);
      }
    }
    for (const type of ["testimonials"]) expect(galleryEntry(`noor-section-${type}-rtl`)?.scenario.locale).toBe("ar");
  });

  it("resolves valid authored section data and renders it through the actual packed host", async () => {
    await BUNDLED_STOREFRONT_EXTENSIONS[NOOR_EXTENSION.pluginId]!.module();
    const currency = { symbol: "৳", code: "BDT" };
    for (const entry of galleryEntries().filter((entry) => entry.family.startsWith("noor-section:"))) {
      const result = await read(entry.id, "storefront/homepage");
      const surfaces = readHomepageAppSurfaces((result.sections as { apps: unknown }).apps);
      expect(surfaces.size, entry.id).toBe(1);
      const surface = [...surfaces.values()][0]!;
      const component = surface.component!;
      const schema = NOOR_EXTENSION.sectionSettings[component.type]!;
      const valid = validatePluginSettingValues(schema, component.values);
      expect(valid.ok ? [] : valid.errors, entry.id).toEqual([]);
      const media = new Map(component.media.flatMap((asset) => {
        const image = storefrontImageOf(asset);
        return image ? [[asset.id, image] as const] : [];
      }));
      const products = new Map(component.lists.map((list) => [list.source, list.products.map((value) => {
        const card = value as ProductCardProduct;
        const page = { currencySymbol: currency.symbol, currencyCode: currency.code };
        return productCardData(card, productCardModel(card, { ...page, hoverImage: true, ratings: true }), page);
      })]));
      const host = new ExtensionHost({ runtime: { env: {} }, context: {
        store: { name: "Gallery store", currency: "BDT", locale: entry.scenario.locale === "ar" ? "ar-AE" : "en-BD", language: "en", timeZone: "Asia/Dhaka" },
        page: { kind: "home", path: "/" }, assets: "", preview: false,
      } });
      const html = await host.render(NOOR_EXTENSION, {
        kind: "section", type: component.type, instanceId: surface.sectionId,
        settings: componentSectionSettings(schema, component.values, media, products),
      });
      const fixture = NOOR_SECTION_FIXTURES[component.type as keyof typeof NOOR_SECTION_FIXTURES];
      expect(html, entry.id).toContain(fixture.subject.slice(1));
      if (component.type === "video") {
        expect(html, entry.id).toContain("<img");
        expect(html, "Poster-only fixture must not claim playback coverage").not.toContain("<video");
      }
    }
  });

  it("uses the installed manifest and actual generated release through the public layout contract", async () => {
    const layout = await read("noor-product", "storefront/layout");
    expect(readStorefrontExtensions(layout.appExtensions)).toEqual([NOOR_EXTENSION]);
    expect(NOOR_EXTENSION.release).toBe(BUNDLED_STOREFRONT_EXTENSIONS[NOOR_EXTENSION.pluginId]!.release);
    expect(NOOR_EXTENSION.skins.map((skin) => skin.target)).toEqual([
      "header", "footer", "product_card", "product_main", "section:hero", "section:product_tabs", "section:product_grid", "section:product_rail",
      "section:category_tiles", "section:shop_by", "section:banner_mosaic", "section:lookbook", "section:deal_block", "section:usp_strip",
      "section:editorial", "section:seo_text", "section:specifications", "section:faq", "section:newsletter",
    ]);
    expect((await read("noor-product-missing", "storefront/layout")).appExtensions).toEqual([]);
    expect(galleryEntry("noor-product-missing")!.theme.apps!.skins!.header).toEqual(galleryEntry("noor-product")!.theme.apps!.skins!.header);
    expect(galleryEntry("noor-product-core")!.theme.apps).toEqual({});
  });

  it("pairs core product modules with both header modes, locales and real page routes", async () => {
    for (const id of ["noor-product", "noor-product-static", "noor-product-core", "noor-product-quiet", "noor-product-bn", "noor-product-rtl"]) {
      const entry = galleryEntry(id)!;
      expect(entry.theme.blocks.product.below).toContain("description");
      expect(entry.theme.blocks.product.sticky).toEqual({ phoneTop: "anchor-bar", phoneBottom: "buy-bar", desktop: "anchor-bar" });
      expect(galleryRenderPlan(id, origin)!.page).toBe("/src/pages/products/[slug].astro");
    }
    expect(galleryEntry("noor-product-static")!.theme.apps!.skins!.header!.values.sticky).toBe(false);
    expect(galleryEntry("noor-product-quiet")!.theme.blocks.topBar.variant).toBe("none");
    expect(galleryNavigation(galleryEntry("noor-product")!)).toHaveLength(5);
    expect(galleryNavigation(galleryEntry("noor-product-dense")!)).toHaveLength(18);
    expect(galleryRenderPlan("noor-product-rtl", origin)!.url).toContain("/ar-ae/products/");
    for (const id of ["noor-product", "noor-product-core", "noor-product-dense"]) {
      const result = await read(id, "products/jamdani-saree");
      const product = result.product as { description: string; additionalInfo: Array<{ id: string; title: string; content: string }> };
      expect(product.description).not.toBe("");
      expect(product.additionalInfo).toHaveLength(id.endsWith("dense") ? 5 : 2);
      expect(product.additionalInfo[0]).toMatchObject({ id: "sizing", title: "Size and materials" });
      expect(product.additionalInfo.every((panel) => panel.content.length > 0)).toBe(true);
    }
  });

  it("serves component inputs, not canned app HTML, including a buyer-resolvable checkout product", async () => {
    const landing = await read("noor-landing", "storefront/landing/eid-sale");
    const sections = landing.sections as { apps: unknown };
    const surfaces = [...readHomepageAppSurfaces(sections.apps).values()];
    const order = surfaces.find((surface) => surface.component?.type === "landing_order")!;
    expect(surfaces.length).toBeGreaterThan(1);
    expect(surfaces.every((surface) => surface.component?.pluginId === NOOR_EXTENSION.pluginId)).toBe(true);
    expect(order.component!.lists[0]!.source).toBe("product:prod_0");
    const product = order.component!.lists[0]!.products[0] as { id: string; slug: string };
    const detail = await read("noor-landing", `products/${product.slug}`);
    expect((detail.product as { id: string }).id).toBe(product.id);
    for (const id of ["noor-home", "noor-listing", "noor-cart", "noor-landing"]) expect(galleryRenderPlan(id, origin)!.page).toMatch(/^\/src\/pages\//);
  });

  it("provides real first-section inputs for transparent header decisions and both core sticky layouts", async () => {
    for (const id of ["noor-home", "noor-home-text", "noor-home-no-image", "noor-home-slideshow"]) {
      expect(galleryEntry(id)!.theme.apps!.skins!.header!.values.transparent_home).toBe(true);
    }
    expect(galleryEntry("noor-home-text")!.theme.pages.home[0]!.type).toBe("editorial");
    // The store's hero drawn by Noor's hero skin: with a photo, then without one.
    for (const [id, slides] of [["noor-home", 1], ["noor-home-no-image", 0]] as const) {
      const hero = galleryEntry(id)!.theme.pages.home[0]!;
      expect(hero.type).toBe("hero");
      if (hero.type === "hero") {
        expect(hero.skin?.app).toBe("scalius.noor/noor_hero");
        expect(hero.settings.slides.length >= slides).toBe(true);
        expect(hero.settings.slides.length === 0).toBe(slides === 0);
      }
    }
    const result = await read("noor-home-slideshow", "storefront/homepage");
    const lead = readHomepageAppSurfaces((result.sections as { apps: unknown }).apps).get(galleryEntry("noor-home-slideshow")!.theme.pages.home[0]!.id)!.component;
    expect(lead.type).toBe("slideshow");
    expect(lead.media).toHaveLength(2);
    const menuRow = galleryEntry("core-product-menu-row")!;
    expect(menuRow.theme.apps?.skins?.header).toBeUndefined();
    expect(menuRow.theme.blocks.desktopNav.variant).toBe("sticky-category-bar");
    expect(galleryEntry("noor-product-buybar")!.theme.blocks.product.sticky.desktop).toBe("product-bar");
    expect(galleryEntry("noor-product-tabs")!.theme.blocks.product.sticky).toEqual({ phoneTop: "none", phoneBottom: "buy-bar", desktop: "none" });
  });

  it("runs the actual packed module in ExtensionHost and serves its CSS and every declared island", async () => {
    // Vite's first module compilation is setup, not part of the production render budget.
    await BUNDLED_STOREFRONT_EXTENSIONS[NOOR_EXTENSION.pluginId]!.module();
    const host = new ExtensionHost({ runtime: { env: {} }, context: {
      store: { name: "Gallery store", currency: "BDT", locale: "en-BD", language: "en", timeZone: "Asia/Dhaka" },
      page: { kind: "product", path: "/products/jamdani-saree" }, assets: "", preview: false,
    } });
    const skin = NOOR_EXTENSION.skins.find((item) => item.target === "header")!;
    const html = await host.render(NOOR_EXTENSION, {
      kind: "skin", target: "header", component: skin.id,
      settings: resolveStorefrontSettings(skin.settings, { sticky: true }, { image: () => null, products: () => [] }),
      data: { store: { name: "Gallery store", url: "/", logo: null, logoWidth: 140 }, menu: [], categories: [], announcement: null,
        routes: { home: "/", search: "/search", cart: "/cart", account: "/account" }, searchParam: "q" },
    });
    expect(html).toContain("noor-header");
    expect(html).toContain('data-island="header"');
    const base = storefrontExtensionBase(NOOR_EXTENSION.pluginId, NOOR_EXTENSION.release);
    for (const path of ["styles.css", ...NOOR_EXTENSION.islands.map((name) => `islands/${name}.js`)]) {
      const response = await serveExtensionFile(new Request(`${origin}${base}${path}`), {});
      expect(response?.status, path).toBe(200);
      expect(response?.headers.get("cache-control"), path).toContain("immutable");
      expect((await response!.text()).length, path).toBeGreaterThan(0);
    }
  });
});
