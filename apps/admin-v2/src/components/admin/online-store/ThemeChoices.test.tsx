import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  EMPTY_STORE_SHAPE,
  STOREFRONT_IMAGE_RATIOS,
  resolveStorefrontTheme,
  storefrontTemplateTheme,
} from "@scalius/shared/storefront-theme";
import { CardStyleSketch, SKETCH_RATIOS } from "./ThemeChoices";

describe("card sketch", () => {
  it.each(STOREFRONT_IMAGE_RATIOS)("draws the %s photo ratio the storefront card uses", (imageRatio) => {
    const theme = storefrontTemplateTheme("rounded-tech");
    theme.tokens.imageRatio = imageRatio;
    const card = resolveStorefrontTheme(theme, EMPTY_STORE_SHAPE).layout.productCard;
    expect(card.imageRatio).toBe(imageRatio);
    const html = renderToStaticMarkup(<CardStyleSketch card={card} />);
    expect(html).toContain(SKETCH_RATIOS[imageRatio]);
    for (const other of STOREFRONT_IMAGE_RATIOS.filter((ratio) => ratio !== imageRatio)) {
      expect(html).not.toContain(SKETCH_RATIOS[other]);
    }
  });
});
