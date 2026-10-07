/**
 * The theme editor's pages, Shopify's Online Store 2.0 shape: the homepage
 * and landing pages are sections; product, collection (and category),
 * cart and CMS pages are templates whose ordinary sections sit before and
 * after one fixed part; search results are the listing alone. Every page
 * shares the announcement bar, header and footer.
 */
import {
  STOREFRONT_PRODUCT_MODULES,
  type StorefrontPageTemplate,
  type StorefrontPreviewScope,
  type StorefrontProductModule,
  type StorefrontSection,
  type StorefrontThemeDocument,
} from "@scalius/shared/storefront-theme";
import { THEME_EDITOR_MARKS, themeEditorModuleMark } from "@scalius/shared/theme-editor-bridge";

type Theme = StorefrontThemeDocument;

export type EditorPage =
  | { kind: "home" }
  | { kind: "landing"; slug: string }
  | { kind: "product" }
  | { kind: "collection" }
  | { kind: "category" }
  | { kind: "search" }
  | { kind: "cart" }
  | { kind: "page" };

export type EditorPageKind = EditorPage["kind"];

/** Pages previewed with one of the store's own resources (a product, a collection...). */
export type ResourcePageKind = "product" | "collection" | "category" | "page";
export const RESOURCE_PAGE_KINDS: readonly ResourcePageKind[] = ["product", "collection", "category", "page"];

/** The store's pages in the page switcher, in Shopify's order. */
export const STORE_PAGE_KINDS = ["home", "product", "collection", "category", "search", "cart", "page"] as const;

export function isResourcePage(page: EditorPage): page is { kind: ResourcePageKind } {
  return (RESOURCE_PAGE_KINDS as readonly string[]).includes(page.kind);
}

export function samePage(left: EditorPage, right: EditorPage): boolean {
  return left.kind === right.kind && (left.kind !== "landing" || left.slug === (right as { slug: string }).slug);
}

/** A stable key for a page (remembered resources, switcher values). */
export function pageKey(page: EditorPage): string {
  return page.kind === "landing" ? `landing:${page.slug}` : page.kind;
}

/** The template a page edits, if it is a template page. Categories and brands share the collection template. */
export function pageTemplate(page: EditorPage): StorefrontPageTemplate | null {
  switch (page.kind) {
    case "product": return "product";
    case "collection":
    case "category": return "collection";
    case "cart": return "cart";
    case "page": return "page";
    default: return null;
  }
}

/** Where a page's sections live in the document, for the preview's render route; null for search. */
export function pageScope(theme: Theme, page: EditorPage): StorefrontPreviewScope | null {
  if (page.kind === "home") return { kind: "home" };
  if (page.kind === "landing") return theme.pages.landing[page.slug] ? { kind: "landing", slug: page.slug } : null;
  const template = pageTemplate(page);
  return template ? { kind: "template", template, main: theme.pages.templates[template].main } : null;
}

/** The page's sections, for the pages that have them. */
export function pageSections(theme: Theme, page: EditorPage): StorefrontSection[] | null {
  if (page.kind === "home") return theme.pages.home;
  if (page.kind === "landing") return theme.pages.landing[page.slug]?.sections ?? null;
  const template = pageTemplate(page);
  return template ? theme.pages.templates[template].sections : null;
}

/** How many of a template page's sections come before its fixed part (null without one). */
export function pageMain(theme: Theme, page: EditorPage): number | null {
  const template = pageTemplate(page);
  return template ? theme.pages.templates[template].main : null;
}

/** The document with the page's sections (and a template's fixed part's place) replaced. */
export function withPageSections(theme: Theme, page: EditorPage, sections: StorefrontSection[], main?: number): Theme {
  if (page.kind === "landing") {
    const landing = theme.pages.landing[page.slug];
    if (!landing) return theme;
    return { ...theme, pages: { ...theme.pages, landing: { ...theme.pages.landing, [page.slug]: { ...landing, sections } } } };
  }
  const template = pageTemplate(page);
  if (template) {
    const current = theme.pages.templates[template];
    const nextMain = Math.max(0, Math.min(sections.length, main ?? current.main));
    return { ...theme, pages: { ...theme.pages, templates: { ...theme.pages.templates, [template]: { sections, main: nextMain } } } };
  }
  if (page.kind === "home") return { ...theme, pages: { ...theme.pages, home: sections } };
  return theme;
}

/**
 * Parts that are not sections. The announcement bar, header and footer are
 * on every page but the cart; `page` is the page's own settings; each
 * template has one fixed part; the product's modules and the listing's
 * pieces are that fixed part's blocks. The parts the storefront marks in a
 * preview carry the bridge's mark ids, so a click in the preview selects them.
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
  pageContent: THEME_EDITOR_MARKS.pageContent,
  cart: THEME_EDITOR_MARKS.cart,
} as const;

export const PRODUCT_MODULES = Object.keys(STOREFRONT_PRODUCT_MODULES) as StorefrontProductModule[];

/** The product module a selection names (`module-reviews`), or null. */
export function selectedModule(selected: string | null): StorefrontProductModule | null {
  const module = selected?.startsWith("module-") ? selected.slice("module-".length) : null;
  return module && (PRODUCT_MODULES as string[]).includes(module) ? module as StorefrontProductModule : null;
}

export { themeEditorModuleMark as moduleId };

/** A page's fixed part (the template's), or null for the homepage and landing pages. */
export function pageFixedPart(page: EditorPage): string | null {
  switch (page.kind) {
    case "product": return EDITOR_PARTS.productMain;
    case "collection":
    case "category":
    case "search": return EDITOR_PARTS.listing;
    case "cart": return EDITOR_PARTS.cart;
    case "page": return EDITOR_PARTS.pageContent;
    default: return null;
  }
}

/** Whether the page shows the shared announcement bar, header and footer (the cart hides them). */
export function pageShowsSharedParts(page: EditorPage): boolean {
  return page.kind !== "cart";
}

/**
 * Where the preview opens a page: home `/`, a landing page `/pages/<slug>`,
 * search `/search`, the cart `/cart`, and a product, collection, category or
 * CMS page at the chosen resource's own address (null until there is one).
 */
export function previewPath(page: EditorPage, resourceUrl: string | null): string | null {
  switch (page.kind) {
    case "home":
      return "/";
    case "landing":
      return `/pages/${page.slug}`;
    case "search":
      return "/search";
    case "cart":
      return "/cart";
    default:
      return resourceUrl;
  }
}
