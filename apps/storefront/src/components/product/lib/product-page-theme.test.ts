import { describe, expect, it } from "vitest";
import {
  EMPTY_STORE_SHAPE,
  STOREFRONT_RETIRED_TEMPLATE_IDS,
  STOREFRONT_TEMPLATE_IDS,
  resolveStorefrontTheme,
  storefrontTemplateTheme,
} from "@scalius/shared/storefront-theme";
import type { Product } from "@/lib/api";
import { productPageModules } from "./product-page-modules";
import { resolveProductPageTheme } from "./product-page-theme";

const theme = storefrontTemplateTheme("department-mall");
const requestTheme = { theme, resolved: resolveStorefrontTheme(theme, EMPTY_STORE_SHAPE) };

describe("product page template", () => {
  it("preserves the request theme exactly without a valid product override", () => {
    for (const override of [undefined, null, "", "unknown"]) {
      expect(resolveProductPageTheme(requestTheme, { pageTemplate: override }, EMPTY_STORE_SHAPE)).toBe(requestTheme.resolved);
    }
  });

  it("resolves every saved template's gallery, buy box and module order together without changing the shell", () => {
    for (const id of STOREFRONT_TEMPLATE_IDS) {
      const expected = resolveStorefrontTheme(storefrontTemplateTheme(id), EMPTY_STORE_SHAPE);
      const actual = resolveProductPageTheme(requestTheme, { pageTemplate: id }, EMPTY_STORE_SHAPE);
      expect(actual.blocks.product, id).toEqual(expected.blocks.product);
      expect(actual.layout.productPage, id).toEqual(expected.layout.productPage);
      expect(actual.layout.buyBox, id).toEqual(expected.layout.buyBox);
      expect(actual.tokens, id).toEqual(requestTheme.resolved.tokens);
      expect(actual.blocks.header, id).toEqual(requestTheme.resolved.blocks.header);
      expect(actual.layout.productCard, id).toEqual(requestTheme.resolved.layout.productCard);
    }
    expect(requestTheme.theme).toEqual(storefrontTemplateTheme("department-mall"));
  });

  it("renders a retired template id as the preset it became", () => {
    expect(STOREFRONT_RETIRED_TEMPLATE_IDS).toEqual({
      "spec-catalogue": "department-mall",
      "rounded-tech": "department-mall",
      "heritage-editorial": "boutique",
      "fashion-value": "boutique",
      "mass-retail": "marketplace",
    });
    const boutiqueStore = storefrontTemplateTheme("boutique");
    const request = { theme: boutiqueStore, resolved: resolveStorefrontTheme(boutiqueStore, EMPTY_STORE_SHAPE) };
    for (const [retired, preset] of Object.entries(STOREFRONT_RETIRED_TEMPLATE_IDS)) {
      const expected = resolveStorefrontTheme(storefrontTemplateTheme(preset), EMPTY_STORE_SHAPE);
      const actual = resolveProductPageTheme(request, { pageTemplate: retired }, EMPTY_STORE_SHAPE);
      expect(actual.blocks.product, retired).toEqual(expected.blocks.product);
      expect(actual.layout.productPage, retired).toEqual(expected.layout.productPage);
      expect(actual.layout.buyBox, retired).toEqual(expected.layout.buyBox);
      // The shell stays the store's own.
      expect(actual.tokens, retired).toEqual(request.resolved.tokens);
      expect(actual.blocks.header, retired).toEqual(request.resolved.blocks.header);
    }
    // "classic" still means the department mall; an id nobody knows keeps the request theme.
    expect(resolveProductPageTheme(request, { pageTemplate: "classic" }, EMPTY_STORE_SHAPE).blocks.product)
      .toEqual(resolveStorefrontTheme(storefrontTemplateTheme("department-mall"), EMPTY_STORE_SHAPE).blocks.product);
    expect(resolveProductPageTheme(request, { pageTemplate: "heritage-editorial-2" }, EMPTY_STORE_SHAPE)).toBe(request.resolved);
  });

  it("keeps content blocks to stores whose shape has them, and to products that carry them", () => {
    const boutique = storefrontTemplateTheme("boutique");
    const product = {
      contentBlocks: [{ id: "video", type: "video", version: 1, settings: {
        heading: "Demo", source: { kind: "media", mediaId: "m_video" },
      } }],
    } as Product;
    // Core's store shape counts public products' rendered blocks (hasContentBlocks).
    expect(resolveStorefrontTheme(boutique, EMPTY_STORE_SHAPE).blocks.product.below).not.toContain("content-blocks");
    const shape = { ...EMPTY_STORE_SHAPE, hasContentBlocks: true };
    const inherited = { theme: boutique, resolved: resolveStorefrontTheme(boutique, shape) };
    for (const pageTemplate of [null, "boutique"]) {
      const resolved = resolveProductPageTheme(inherited, { pageTemplate }, shape);
      expect(resolved.blocks.product.below).toContain("content-blocks");
      expect(productPageModules(resolved.blocks.product.below, product, {
        look: resolved.layout.buyBox.look, hasRelated: false,
      })).toEqual(["content-blocks"]);
      const empty = { ...product, contentBlocks: [] };
      expect(productPageModules(resolved.blocks.product.below, empty, {
        look: resolved.layout.buyBox.look, hasRelated: false,
      })).toEqual([]);
    }
  });

  it("classic restores the protected department-mall product page even on a boutique store", () => {
    const boutique = storefrontTemplateTheme("boutique");
    const resolved = resolveProductPageTheme({
      theme: boutique,
      resolved: resolveStorefrontTheme(boutique, EMPTY_STORE_SHAPE),
    }, { pageTemplate: "classic" }, EMPTY_STORE_SHAPE);
    expect(resolved.blocks.product).toEqual(requestTheme.resolved.blocks.product);
    expect(resolved.layout.productPage).toEqual(requestTheme.resolved.layout.productPage);
    expect(resolved.layout.buyBox).toEqual(requestTheme.resolved.layout.buyBox);
    expect(resolved.tokens).toEqual(boutique.tokens);
  });

  it("resolves phone buy-bar visibility from each product's page override", () => {
    const pantry = storefrontTemplateTheme("daily-essentials");
    const pantryRequest = { theme: pantry, resolved: resolveStorefrontTheme(pantry, EMPTY_STORE_SHAPE) };
    expect(resolveProductPageTheme(pantryRequest, { pageTemplate: null }, EMPTY_STORE_SHAPE).blocks.product.sticky.phoneBottom).toBe("none");
    expect(resolveProductPageTheme(pantryRequest, { pageTemplate: "department-mall" }, EMPTY_STORE_SHAPE).blocks.product.sticky.phoneBottom).toBe("buy-bar");
    expect(resolveProductPageTheme(requestTheme, { pageTemplate: "daily-essentials" }, EMPTY_STORE_SHAPE).blocks.product.sticky.phoneBottom).toBe("none");
  });

  it("resolves contact-friendly buy boxes from the product override", () => {
    const showcase = storefrontTemplateTheme("showcase-landing");
    const showcaseRequest = { theme: showcase, resolved: resolveStorefrontTheme(showcase, EMPTY_STORE_SHAPE) };
    const contact = (request: typeof showcaseRequest, pageTemplate: string | null) =>
      resolveProductPageTheme(request, { pageTemplate }, EMPTY_STORE_SHAPE).layout.buyBox.whatsapp;
    expect(contact(showcaseRequest, null)).toBe(true);
    expect(contact(showcaseRequest, "classic")).toBe(false);
    expect(contact(requestTheme, "showcase-landing")).toBe(true);
  });
});
