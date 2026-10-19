/** Real bundled Noor metadata and fixture data; all rendering stays in the production host. */
import { parsePluginManifest } from "@scalius/shared/plugins/manifest";
import { storefrontSettingNeeds, type StorefrontExtension, type StorefrontSkinTarget } from "@scalius/shared/plugins/storefront-components";
import { STOREFRONT_DECLARATION_THEME_VERSION, applyStorefrontAppTemplate, readStorefrontAppTemplateTheme, readStorefrontPagePresetSections, type StorefrontSection, type StorefrontThemeDocument } from "@scalius/shared/storefront-theme";
import { BUNDLED_STOREFRONT_EXTENSIONS } from "../extensions/bundled.gen";
import { manifest } from "../../../../plugins/noor/src/index";
import type { HomepageAppSurface } from "../lib/app-surfaces";
import { cardProducts, mediaAsset, productDetail, type ProductScenario } from "./fixtures";

const parsed = parsePluginManifest(manifest);
if (!parsed.ok) throw new Error("The gallery needs a valid Noor manifest.");
const storefront = parsed.manifest.storefront;
const bundled = BUNDLED_STOREFRONT_EXTENSIONS[manifest.id];
if (!bundled) throw new Error("Pack Noor with pnpm plugin before opening its gallery cases.");

/** Same public layout shape as an active, approved bundled installation. */
export const NOOR_EXTENSION: StorefrontExtension = {
  pluginId: manifest.id,
  version: manifest.version,
  source: "bundled",
  release: bundled.release,
  sections: storefront.sections.map((section) => section.type),
  sectionSettings: Object.fromEntries(storefront.sections.map((section) => [section.type, section.settings])),
  skins: storefront.skins.map(({ id, target, settings }) => ({ id, target: target as StorefrontSkinTarget, settings })),
  blocks: storefront.productBlocks
    .map((block) => ({ type: block.type, target: `product.${block.placement}` as const, settings: block.settings })),
  islands: storefront.islands.map((island) => island.name),
  stylesheet: storefront.stylesheet,
  connect: storefront.connect,
};

/** Apply the actual plugin template through the same shared operation as the merchant builder. */
export function noorTheme(base: StorefrontThemeDocument): StorefrontThemeDocument {
  const template = readStorefrontAppTemplateTheme(storefront.templates[0]?.theme, storefront.templates[0]?.themeVersion ?? STOREFRONT_DECLARATION_THEME_VERSION);
  if (!template) throw new Error("The Noor template no longer fits the theme document.");
  const theme = applyStorefrontAppTemplate(base, "scalius.noor/noor", template);
  theme.pages.home = theme.pages.home.map((section) => {
    if (section.type !== "app") return section;
    const values = { ...section.settings.values };
    if (section.settings.app === "scalius.noor/hero") values.image = "banner-eid";
    if (section.settings.app === "scalius.noor/featured-product") values.product = "prod_0";
    if (section.settings.app === "scalius.noor/image-text") values.image = "wide-story";
    if (section.settings.app === "scalius.noor/collection-tiles") values.tiles = [
      { image: "product-0", title: "Handwoven sarees", link: "/categories/women" },
      { image: "product-3", title: "Everyday essentials", link: "/collections/col-eid" },
    ];
    return { ...section, settings: { ...section.settings, values } };
  });
  return theme;
}

export function noorLandingSections(): StorefrontSection[] {
  const sections = readStorefrontPagePresetSections(storefront.pagePresets[0]?.sections, storefront.pagePresets[0]?.themeVersion ?? STOREFRONT_DECLARATION_THEME_VERSION);
  if (!sections) throw new Error("The Noor campaign preset no longer fits the section document.");
  return sections.map((section) => section.type === "app" && ["scalius.noor/landing-hero", "scalius.noor/landing-order"].includes(section.settings.app)
    ? { ...section, settings: { ...section.settings, values: { ...section.settings.values, product: "prod_0" } } }
    : section);
}

/** API data only: the packed module and AppComponent render these through the real host. */
export function noorSectionSurfaces(sections: readonly StorefrontSection[], product: ProductScenario = "fashion"): HomepageAppSurface[] {
  return sections.flatMap((section) => {
    if (section.type !== "app" || !section.settings.app.startsWith(`${manifest.id}/`)) return [];
    const type = section.settings.app.slice(manifest.id.length + 1);
    const schema = NOOR_EXTENSION.sectionSettings[type];
    if (!schema) return [];
    const needs = storefrontSettingNeeds(schema, section.settings.values);
    return [{
      sectionId: section.id,
      component: {
        pluginId: manifest.id,
        type,
        values: section.settings.values,
        media: needs.mediaIds.map((id) => mediaAsset(id)),
        lists: needs.products.map(({ source, limit }) => ({
          source,
          products: source.startsWith("product:")
            ? [productDetail(product).product].filter((item) => source === `product:${item.id}`)
            : cardProducts(limit, 0, { bangla: product === "bangla" }),
        })),
      },
    }];
  });
}
