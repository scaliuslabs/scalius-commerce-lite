import { privatePageTokenMode, type PrivatePageKey, type StorefrontThemeDocument } from "@scalius/shared/storefront-theme";
import { privateStyle } from "./plan";

/**
 * What a page that carries the model's hooks but still draws its own markup
 * (the account) passes its Layout for the theme's look: the compiled token
 * rules in token mode only. Otherwise nothing, so the page draws exactly as
 * without a theme: the Layout drops the theme's page paint under a private
 * style that is not in token mode.
 */
export function privatePageLook(theme: StorefrontThemeDocument, page: PrivatePageKey): { privateStyle?: string; privateTokens?: boolean } {
  return privatePageTokenMode(theme.privatePages, page) ? { privateStyle: privateStyle(theme, page), privateTokens: true } : {};
}
