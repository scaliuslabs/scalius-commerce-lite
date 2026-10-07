/**
 * What a theme paints without changing the page's markup: the custom
 * properties of `:root` (tokens, the fluid grid, the card's look), the
 * data attributes on `.site-root` that CSS selects on, and the font faces of
 * its type pairing. The Layout writes them into every page; the theme
 * editor's preview-only paint route returns them for an unsaved document,
 * so a colour, font or density edit shows without a reload. CSS comes only
 * from shared constants and schema-validated hex colours.
 */
import type { ResolvedStorefrontTheme, StorefrontThemeDocument } from "@scalius/shared/storefront-theme";
import { buildStorefrontThemeTokens } from "@scalius/shared/storefront-theme";
import { cardLookTokens, cardPageAttributes } from "@/components/cards/card-model";
import { productGridFluidCss, productGridSpec } from "@/lib/product-card-layout";
import { themeFontAssets, type ThemeFontAssets } from "@/lib/theme-fonts";

export interface ThemePaint {
  /** `:root, .site-root { --name: value; ... }` */
  css: string;
  /** The body's theme attributes (density, type, radius...). */
  attributes: Record<string, string>;
  /** The body's card flags (`data-card-*`), store-wide. */
  cardAttributes: Record<string, string>;
  fonts: ThemeFontAssets;
}

export function themePaint(theme: StorefrontThemeDocument, resolved: ResolvedStorefrontTheme): ThemePaint {
  const layout = resolved.layout;
  const tokens = theme.tokens;
  const productGrid = productGridSpec(layout.grid, tokens.imageRatio);
  const fluidGrid = productGridFluidCss(productGrid);
  // Every card of the store shares one look and its flags: written once
  // here (theme-cards.css draws with them), never repeated per card.
  const cardVariant = resolved.blocks.card.variant;
  const entries = Object.entries({
    ...buildStorefrontThemeTokens(theme),
    "theme-card-min-tablet": productGrid.cardMin.tablet,
    "theme-card-min-desktop": productGrid.cardMin.desktop,
    "grid-card-min-fluid": fluidGrid.cardMin,
    "grid-gap-fluid": fluidGrid.gap,
    ...Object.fromEntries(cardLookTokens(cardVariant, layout.productCard)),
  });
  return {
    css: `:root, .site-root { ${entries.map(([key, value]) => `--${key}: ${value}`).join("; ")}; }`,
    attributes: {
      "data-theme-density": layout.density,
      "data-theme-card-style": layout.cardSurface,
      "data-theme-typography": tokens.typography,
      "data-theme-type-scale": tokens.typeScale,
      "data-theme-heading-case": tokens.headingCase,
      "data-theme-image-fit": tokens.imageFit,
      "data-theme-radius": tokens.radius,
    },
    cardAttributes: cardPageAttributes(cardVariant, layout.productCard),
    fonts: themeFontAssets(tokens.typography),
  };
}
