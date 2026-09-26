import { describe, expect, it } from "vitest";
import {
  EMPTY_STORE_SHAPE,
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

  it("renders saved content despite a stale store shape, with inherited or assigned templates", () => {
    const boutique = storefrontTemplateTheme("boutique");
    const inherited = { theme: boutique, resolved: resolveStorefrontTheme(boutique, EMPTY_STORE_SHAPE) };
    const product = {
      contentBlocks: [{ id: "video", type: "video", version: 1, settings: {
        heading: "Demo", source: { kind: "media", mediaId: "m_video" },
      } }],
    } as Product;
    expect(inherited.resolved.blocks.product.below).not.toContain("content-blocks");
    for (const pageTemplate of [null, "boutique"]) {
      const resolved = resolveProductPageTheme(inherited, { ...product, pageTemplate }, EMPTY_STORE_SHAPE);
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
});
