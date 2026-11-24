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
  /** The kind of check, and the template's id. */
  id: string;
  theme: Record<string, unknown>;
  /** A path the store names (in the document) and the reason it gives (null: its words only). */
  path: string;
  reason: string | null;
}

export const STOREFRONT_TEMPLATE_REFUSAL_VERSION = STOREFRONT_THEME_DOCUMENT_VERSION;

export const STOREFRONT_TEMPLATE_REFUSALS: readonly StorefrontTemplateRefusal[] = [
  // The light palette: the sale price (destructive) on the product card below 4.5:1.
  { id: "light-contrast", theme: { tokens: { ...tokens, colors: { ...tokens.colors, destructive: "#e5484d" } } }, path: "tokens.colors.destructive", reason: null },
  // The dark palette the template shows, as written (applying never remakes a template's own).
  { id: "dark-contrast", theme: { tokens: { ...tokens, colorScheme: "dark", darkColors: { ...dark, destructive: dark.card } } }, path: "tokens.darkColors.destructive", reason: null },
  // Helper text that reads as a brand colour or an error.
  { id: "muted-colour", theme: { tokens: { ...tokens, colors: { ...tokens.colors, "muted-foreground": "#2b50aa" } } }, path: "tokens.colors.muted-foreground", reason: null },
  // A private page's token text the buyer could not read.
  { id: "private-token", theme: { privatePages: { tokens: { cart: { "summary-total": { text: "#ffffff" } } } } }, path: "privatePages.tokens.cart.summary-total", reason: "contrast" },
  // Words among the amounts carrying a figure.
  { id: "private-label", theme: { privatePages: { labels: { "cart.summaryHeading": { en: "Total ৳0" } } } }, path: "privatePages.labels.cart.summaryHeading.en", reason: "label_figures" },
  // An arrangement that leaves out a part the page must show.
  { id: "private-arrangement", theme: { privatePages: { pages: { cart: { layout: [{ type: "part", part: "lines" }] } } } }, path: "privatePages.pages.cart.layout", reason: "missing_part" },
];

/** The document a merchant saves with a template's values set by hand in the editor: what the store's save checks. */
export function storefrontTemplateRefusalDocument(theme: Record<string, unknown>): Record<string, unknown> {
  const document = structuredClone(DEFAULT_STOREFRONT_THEME) as unknown as Record<string, unknown>;
  if (theme.tokens) document.tokens = theme.tokens;
  if (theme.privatePages) document.privatePages = { ...(document.privatePages as object), ...(theme.privatePages as object) };
  return document;
}
