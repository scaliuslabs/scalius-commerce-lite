// App templates a store refuses, one per kind of save check: the store's
// save test (app-template-save.test.ts) and `scalius-plugin validate`'s test
// (scripts/plugins.test.mjs) both read them, so the two refuse the same
// templates for the same reasons.

import { storefrontDarkPalette } from "./tokens";
import { DEFAULT_STOREFRONT_THEME } from "./templates";
import { STOREFRONT_THEME_DOCUMENT_VERSION } from "./document";

const tokens = DEFAULT_STOREFRONT_THEME.tokens;
const dark = storefrontDarkPalette(tokens.colors);

export interface StorefrontTemplateRefusal {
  /** The kind of check, and the template's id (a manifest key: lowercase words joined by `_`). */
  id: string;
  theme: Record<string, unknown>;
  /** A path the store names (in the document) and the reason it gives (null: its words only). */
  path: string;
  reason: string | null;
}

export const STOREFRONT_TEMPLATE_REFUSAL_VERSION = STOREFRONT_THEME_DOCUMENT_VERSION;

export const STOREFRONT_TEMPLATE_REFUSALS: readonly StorefrontTemplateRefusal[] = [
  // The light palette: the sale price (destructive) on the product card below 4.5:1.
  { id: "light_contrast", theme: { tokens: { ...tokens, colors: { ...tokens.colors, destructive: "#e5484d" } } }, path: "tokens.colors.destructive", reason: null },
  // The dark palette the template shows, as written (applying never remakes a template's own).
  { id: "dark_contrast", theme: { tokens: { ...tokens, colorScheme: "dark", darkColors: { ...dark, destructive: dark.card } } }, path: "tokens.darkColors.destructive", reason: null },
  // Helper text that reads as a brand colour or an error.
  { id: "muted_colour", theme: { tokens: { ...tokens, colors: { ...tokens.colors, "muted-foreground": "#2b50aa" } } }, path: "tokens.colors.muted-foreground", reason: null },
  // A private page's token text the buyer could not read.
  { id: "private_token", theme: { privatePages: { tokens: { cart: { "summary-total": { text: "#ffffff" } } } } }, path: "privatePages.tokens.cart.summary-total", reason: "contrast" },
  // Words among the amounts carrying a figure.
  { id: "private_label", theme: { privatePages: { labels: { "cart.summaryHeading": { en: "Total ৳0" } } } }, path: "privatePages.labels.cart.summaryHeading.en", reason: "label_figures" },
  // An arrangement that leaves out a part the page must show.
  // An icon from another app's files: a private page names only the theme's own (the store's foreign_asset).
  { id: "foreign_icon", theme: { privatePages: { icons: { "cart.empty": { app: "someone.else", file: "icon.svg" } } } }, path: "privatePages.icons.cart.empty", reason: "foreign_asset" },
  { id: "private_arrangement", theme: { privatePages: { pages: { cart: { layout: [{ type: "part", part: "lines" }] } } } }, path: "privatePages.pages.cart.layout", reason: "missing_part" },
];

/** The app whose templates the refusals are. */
export const STOREFRONT_TEMPLATE_REFUSAL_APP = "acme.studio";

/**
 * The document a merchant saves with a template's values set by hand in the
 * editor, on the look of template `id` of the refusals' app: what the store's save checks.
 */
export function storefrontTemplateRefusalDocument(theme: Record<string, unknown>, id: string): Record<string, unknown> {
  const document = structuredClone(DEFAULT_STOREFRONT_THEME) as unknown as Record<string, unknown>;
  document.apps = { template: `${STOREFRONT_TEMPLATE_REFUSAL_APP}/${id}` };
  if (theme.tokens) document.tokens = theme.tokens;
  if (theme.privatePages) document.privatePages = { ...(document.privatePages as object), ...(theme.privatePages as object) };
  return document;
}
