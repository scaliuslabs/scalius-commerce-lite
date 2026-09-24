/**
 * The theme a request renders with: the published theme, or the merchant's
 * draft while a dashboard theme preview cookie is active. Resolved once per
 * request and shared through `locals`, so pages (homepage order, product
 * layout), the Layout and every product card agree without extra reads.
 */
import {
  DEFAULT_STOREFRONT_THEME_SETTINGS,
  sanitizeStorefrontThemeSettings,
  type StorefrontThemeSettings,
} from "@scalius/shared/storefront-theme";
import { resolveThemePreview, type ThemePreviewData } from "./api/storefront";
import { readThemePreviewCookie } from "./theme-preview-cookie";

export interface RequestTheme {
  theme: StorefrontThemeSettings;
  /** The cookie's token, when the request carries one (valid or not). */
  previewToken: string | null;
  preview: ThemePreviewData | null;
}

interface ThemeLocals {
  storefrontTheme?: Promise<RequestTheme>;
}

export function resolveRequestTheme(
  astro: { request: Request; locals: object },
  publishedTheme: unknown,
): Promise<RequestTheme> {
  const locals = astro.locals as ThemeLocals;
  locals.storefrontTheme ??= (async () => {
    const previewToken = readThemePreviewCookie(astro.request.headers.get("cookie")) || null;
    const preview = previewToken ? await resolveThemePreview(previewToken) : null;
    return {
      theme: sanitizeStorefrontThemeSettings(preview?.theme ?? publishedTheme),
      previewToken,
      preview,
    };
  })();
  return locals.storefrontTheme;
}

/** The request's theme once a page or the Layout resolved it; defaults otherwise. */
export async function currentRequestTheme(locals: object): Promise<StorefrontThemeSettings> {
  const pending = (locals as ThemeLocals).storefrontTheme;
  return pending ? (await pending).theme : DEFAULT_STOREFRONT_THEME_SETTINGS;
}
