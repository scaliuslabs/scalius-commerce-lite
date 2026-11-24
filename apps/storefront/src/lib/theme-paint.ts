/**
 * What a theme paints without changing the page's markup: the custom
 * properties of `:root` (tokens and the fluid grid), the data attributes
 * on `.site-root` that CSS selects on, the font faces of its type pairing,
 * and its colour scheme (`<html data-color-scheme>`, lib/color-scheme.ts).
 * The Layout writes them into every page; the theme editor's preview-only
 * paint route returns them for an unsaved document, so a colour, font or
 * density edit shows without a reload. CSS comes only from shared
 * constants and schema-validated hex colours.
 */
import type { ResolvedStorefrontTheme, StorefrontColorScheme, StorefrontThemeDocument } from "@scalius/shared/storefront-theme";
import {
  buildStorefrontColorCss,
  buildStorefrontThemeTokens,
  storefrontThemeColorsAreDark,
  storefrontThemeShowsDarkColors,
} from "@scalius/shared/storefront-theme";
import { productGridFluidCss, productGridSpec } from "@/lib/product-card-layout";
import { themeFontAssets, type ThemeFontAssets } from "@/lib/theme-fonts";

/** A theme that shows its dark colours: its scheme and whether buyers may switch. */
export interface ThemeColorScheme {
  scheme: StorefrontColorScheme;
  toggle: boolean;
}

export interface ThemePaint {
  /**
   * `:root, .site-root { --name: value; ... }`, then the dark colours under
   * `[data-color-scheme=dark]` (and, for the device scheme without
   * JavaScript, under `prefers-color-scheme: dark`).
   */
  css: string;
  /** The body's theme attributes (density, type, radius...). */
  attributes: Record<string, string>;
  fonts: ThemeFontAssets;
  /** Null for a light-only theme: no attribute, no script, no dark CSS. */
  colorScheme: ThemeColorScheme | null;
}

const declarations = (entries: Record<string, string>) => Object.entries(entries).map(([key, value]) => `--${key}: ${value}`).join("; ");

/** The dark colours' block: the page and every `.site-root` under the scheme's selector. */
function darkBlock(root: string, colors: Record<string, string>, dark: boolean): string {
  return `${root}, ${root} .site-root { color-scheme: ${dark ? "dark" : "light"}; ${declarations(colors)}; }`;
}

export function themePaint(theme: StorefrontThemeDocument, resolved: ResolvedStorefrontTheme): ThemePaint {
  const layout = resolved.layout;
  const tokens = theme.tokens;
  const productGrid = productGridSpec(layout.grid, tokens.imageRatio);
  const fluidGrid = productGridFluidCss(productGrid);
  // The colours' tokens exactly as before colour schemes (the ink surface is the
  // text colour, the CSS default); colours that are dark themselves only ask
  // for the browser's dark controls.
  const light = declarations({
    ...buildStorefrontThemeTokens(theme),
    "theme-card-min-tablet": productGrid.cardMin.tablet,
    "theme-card-min-desktop": productGrid.cardMin.desktop,
    "grid-card-min-fluid": fluidGrid.cardMin,
    "grid-gap-fluid": fluidGrid.gap,
  });
  let css = `:root, .site-root { ${storefrontThemeColorsAreDark(tokens.colors) ? "color-scheme: dark; " : ""}${light}; }`;
  const darkColors = storefrontThemeShowsDarkColors(tokens) ? tokens.darkColors : null;
  if (darkColors) {
    const colors = buildStorefrontColorCss(darkColors, tokens.headerTone);
    const dark = storefrontThemeColorsAreDark(darkColors);
    // On screens only: a printed page keeps the light colours.
    css += ` @media screen { ${darkBlock(":root[data-color-scheme=dark]", colors, dark)} }`;
    // The head script resolves `system` to light or dark; this covers a page without JavaScript.
    if (tokens.colorScheme === "system") css += ` @media screen and (prefers-color-scheme: dark) { ${darkBlock(":root[data-color-scheme=system]", colors, dark)} }`;
  }
  return {
    css,
    attributes: {
      "data-theme-density": layout.density,
      "data-theme-typography": tokens.typography,
      "data-theme-type-scale": tokens.typeScale,
      "data-theme-heading-case": tokens.headingCase,
      "data-theme-image-fit": tokens.imageFit,
      "data-theme-radius": tokens.radius,
    },
    fonts: themeFontAssets(tokens.typography),
    colorScheme: darkColors ? { scheme: tokens.colorScheme, toggle: tokens.colorSchemeToggle } : null,
  };
}
