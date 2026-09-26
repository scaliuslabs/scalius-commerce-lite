import { describe, expect, it } from "vitest";
import { STOREFRONT_TEMPLATE_IDS } from "@scalius/shared/storefront-theme/document";
import { STOREFRONT_LISTING_FILTER_STYLES, STOREFRONT_LISTING_VARIANTS } from "@scalius/shared/storefront-theme/blocks";
import { TEMPLATE_ID_PATTERN } from "@scalius/shared/catalog-tree";
import {
  LISTING_FILTER_TEMPLATE_IDS,
  LISTING_LAYOUT_TEMPLATE_IDS,
  PRODUCT_PAGE_TEMPLATE_IDS,
} from "./template-options";

describe("template options", () => {
  it("offers the theme's templates and listing choices", () => {
    expect(PRODUCT_PAGE_TEMPLATE_IDS).toEqual(["classic", ...STOREFRONT_TEMPLATE_IDS]);
    expect(LISTING_LAYOUT_TEMPLATE_IDS).toEqual(Object.keys(STOREFRONT_LISTING_VARIANTS));
    expect(LISTING_FILTER_TEMPLATE_IDS).toEqual([...STOREFRONT_LISTING_FILTER_STYLES]);
  });

  it("only offers ids the API accepts", () => {
    for (const id of [...PRODUCT_PAGE_TEMPLATE_IDS, ...LISTING_LAYOUT_TEMPLATE_IDS, ...LISTING_FILTER_TEMPLATE_IDS]) {
      expect(id).toMatch(TEMPLATE_ID_PATTERN);
    }
  });
});
