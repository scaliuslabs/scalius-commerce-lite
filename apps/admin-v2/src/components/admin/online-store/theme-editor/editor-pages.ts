/**
 * The theme editor's pages and the parts of each a merchant selects, as
 * Shopify's editor has them: every page shares the header and footer; the
 * homepage and landing pages are sections; product, collection, category
 * and search pages are the document's product and listing blocks; a CMS
 * page is its content between the header and footer.
 */
import {
  STOREFRONT_PRODUCT_MODULES,
  type StorefrontProductModule,
  type StorefrontSection,
  type StorefrontThemeDocument,
} from "@scalius/shared/storefront-theme";
import { THEME_EDITOR_MARKS, themeEditorModuleMark } from "@scalius/shared/theme-editor-bridge";

export type EditorPage =
  | { kind: "home" }
  | { kind: "landing"; slug: string }
  | { kind: "product" }
  | { kind: "collection" }
  | { kind: "category" }
  | { kind: "search" }
  | { kind: "page" };

/** Pages previewed with one of the store's own resources (a product, a collection...). */
export type ResourcePageKind = "product" | "collection" | "category" | "page";
export const RESOURCE_PAGE_KINDS: readonly ResourcePageKind[] = ["product", "collection", "category", "page"];

export function isResourcePage(page: EditorPage): page is { kind: ResourcePageKind } {
  return (RESOURCE_PAGE_KINDS as readonly string[]).includes(page.kind);
}

export function samePage(left: EditorPage, right: EditorPage): boolean {
  return left.kind === right.kind && (left.kind !== "landing" || left.slug === (right as { slug: string }).slug);
}

/**
 * Parts that are not sections. `header`, `footer` and `page` (the page's
 * own settings) are on every page; the rest belong to the product and
 * listing pages, and the ones the storefront marks in a preview carry the
 * bridge's mark ids, so a click in the preview selects them.
 */
export const EDITOR_PARTS = {
  header: THEME_EDITOR_MARKS.header,
  announcement: THEME_EDITOR_MARKS.announcement,
  footer: THEME_EDITOR_MARKS.footer,
  page: "page-settings",
  productMain: THEME_EDITOR_MARKS.productMain,
  productApps: THEME_EDITOR_MARKS.productApps,
  listing: THEME_EDITOR_MARKS.listing,
  listingFilters: THEME_EDITOR_MARKS.listingFilters,
  listingToolbar: "listing-toolbar",
} as const;

export const PRODUCT_MODULES = Object.keys(STOREFRONT_PRODUCT_MODULES) as StorefrontProductModule[];

/** The product module a selection names (`module-reviews`), or null. */
export function selectedModule(selected: string | null): StorefrontProductModule | null {
  const module = selected?.startsWith("module-") ? selected.slice("module-".length) : null;
  return module && (PRODUCT_MODULES as string[]).includes(module) ? module as StorefrontProductModule : null;
}

export { themeEditorModuleMark as moduleId };

/** The page's sections, for the pages that have them. */
export function pageSections(theme: StorefrontThemeDocument, page: EditorPage): StorefrontSection[] | null {
  if (page.kind === "home") return theme.pages.home;
  if (page.kind === "landing") return theme.pages.landing[page.slug]?.sections ?? null;
  return null;
}

/** The document with the page's sections replaced (the homepage's or one landing page's). */
export function withPageSections(theme: StorefrontThemeDocument, page: EditorPage, sections: StorefrontSection[]): StorefrontThemeDocument {
  if (page.kind === "landing") {
    const landing = theme.pages.landing[page.slug];
    if (!landing) return theme;
    return { ...theme, pages: { ...theme.pages, landing: { ...theme.pages.landing, [page.slug]: { ...landing, sections } } } };
  }
  return { ...theme, pages: { ...theme.pages, home: sections } };
}

/**
 * Where the preview opens a page: home `/`, a landing page `/pages/<slug>`,
 * search `/search`, and a product, collection, category or CMS page at the
 * chosen resource's own address (null until there is one).
 */
export function previewPath(page: EditorPage, resourceUrl: string | null): string | null {
  switch (page.kind) {
    case "home":
      return "/";
    case "landing":
      return `/pages/${page.slug}`;
    case "search":
      return "/search";
    default:
      return resourceUrl;
  }
}
