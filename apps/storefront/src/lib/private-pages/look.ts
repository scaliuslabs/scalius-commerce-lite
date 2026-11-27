import { privatePageOfPath, privatePageOfRoute, privatePageTokenMode, type PrivatePageKey, type StorefrontThemeDocument } from "@scalius/shared/storefront-theme";
import { privateStyle } from "./plan";

/**
 * What a page that carries the model's hooks but still draws its own markup
 * (the receipt, the account) passes its Layout for the theme's look: the
 * compiled token rules in token mode only. Otherwise nothing, so the page
 * draws exactly as it does without a look of its own (the theme's page paint
 * included, as these pages have always drawn it).
 */
export function privatePageLook(theme: StorefrontThemeDocument, page: PrivatePageKey): { privateStyle?: string; privateTokens?: boolean } {
  return privatePageTokenMode(theme.privatePages, page) ? { privateStyle: privateStyle(theme, page), privateTokens: true } : {};
}

/**
 * The look of the page key whose routes hold this page's route (`PRIVATE_PAGE_ROUTES`, the one table the pages, the
 * theme authors' reference and the storefront's route test read): a page never names its key, so a key reaches
 * exactly the routes the table gives it. A route the table gives no key draws the store's look.
 */
export function privateRouteLook(route: { routePattern: string; url: URL }, theme: StorefrontThemeDocument): { privateStyle?: string; privateTokens?: boolean } {
  // By its pattern; a renderer that serves a page at its path (a test's container) names the path as its pattern.
  const page = privatePageOfRoute(route.routePattern) ?? privatePageOfPath(route.url.pathname);
  return page ? privatePageLook(theme, page) : {};
}
