import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  EMPTY_STORE_SHAPE,
  STOREFRONT_CARD_ACTIONS,
  STOREFRONT_CARD_FACTS,
  STOREFRONT_IMAGE_RATIOS,
  resolveStorefrontTheme,
  storefrontTemplateTheme,
} from "@scalius/shared/storefront-theme";
import { CardStyleSketch, SKETCH_RATIOS } from "./ThemeChoices";

/** The card the theme resolves to, after these settings and photo tokens are set. */
function resolvedCard(settings: { facts: (typeof STOREFRONT_CARD_FACTS)[number]; action: (typeof STOREFRONT_CARD_ACTIONS)[number]; hoverImage: boolean }, tokens: { imageRatio?: (typeof STOREFRONT_IMAGE_RATIOS)[number] } = {}) {
  const theme = storefrontTemplateTheme("department-mall");
  theme.blocks.card = { variant: "standard", settings };
  Object.assign(theme.tokens, tokens);
  return resolveStorefrontTheme(theme, EMPTY_STORE_SHAPE).layout.productCard;
}

describe("card sketch", () => {
  // The one card takes the theme's photo ratio token.
  it.each(STOREFRONT_IMAGE_RATIOS)("draws the %s photo ratio the storefront card uses", (imageRatio) => {
    const card = resolvedCard({ facts: "none", action: "none", hoverImage: false }, { imageRatio });
    expect(card.imageRatio).toBe(imageRatio);
    const html = renderToStaticMarkup(<CardStyleSketch card={card} />);
    expect(html).toContain(SKETCH_RATIOS[imageRatio]);
    for (const other of STOREFRONT_IMAGE_RATIOS.filter((ratio) => ratio !== imageRatio)) {
      expect(html).not.toContain(SKETCH_RATIOS[other]);
    }
  });

  it("draws the buy action: a round add marker for quick-add, an outline bar for full, neither for none", () => {
    const count = (html: string, attribute: string) => html.split(attribute).length - 1;
    const sketch = (action: (typeof STOREFRONT_CARD_ACTIONS)[number]) =>
      renderToStaticMarkup(<CardStyleSketch card={resolvedCard({ facts: "none", action, hoverImage: false })} />);
    // Two tiles per sketch.
    expect(count(sketch("quick-add"), "data-card-sketch-round-action")).toBe(2);
    expect(count(sketch("quick-add"), "data-card-sketch-full-action")).toBe(0);
    expect(count(sketch("full"), "data-card-sketch-full-action")).toBe(2);
    expect(count(sketch("full"), "data-card-sketch-round-action")).toBe(0);
    expect(sketch("none")).not.toContain("data-card-sketch-round-action");
    expect(sketch("none")).not.toContain("data-card-sketch-full-action");
  });

  it("draws a facts line for every fact but none", () => {
    for (const facts of STOREFRONT_CARD_FACTS) {
      const html = renderToStaticMarkup(<CardStyleSketch card={resolvedCard({ facts, action: "none", hoverImage: false })} />);
      if (facts === "none") expect(html).not.toContain("data-card-sketch-facts");
      else expect(html).toContain(`data-card-sketch-facts="${facts}"`);
    }
  });

  it("draws the second photo only when the card shows it on hover", () => {
    const withHover = renderToStaticMarkup(<CardStyleSketch card={resolvedCard({ facts: "none", action: "none", hoverImage: true })} />);
    const without = renderToStaticMarkup(<CardStyleSketch card={resolvedCard({ facts: "none", action: "none", hoverImage: false })} />);
    expect(withHover).toContain("w-1/3");
    expect(without).not.toContain("w-1/3");
  });
});
