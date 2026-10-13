/**
 * The theme a request renders with: the published theme, or the merchant's
 * draft while a dashboard theme preview cookie is active, resolved against
 * the store's shape with the same resolver the dashboard uses, with its
 * brand images (logo, footer logo, favicon). Resolved once per request and
 * shared through `locals`, so pages (homepage sections, product layout), the
 * Layout and every product card agree without extra reads.
 */
import {
  DEFAULT_STOREFRONT_THEME,
  EMPTY_STORE_SHAPE,
  EMPTY_STOREFRONT_BRAND_ASSETS,
  resolveStorefrontTheme,
  storeShapeSchema,
  storefrontThemeDocumentSchema,
  type ResolvedStorefrontTheme,
  type ResolvedStorefrontThemeLayout,
  type StoreShape,
  type StorefrontBrandAsset,
  type StorefrontBrandAssets,
  type StorefrontThemeBrand,
  type StorefrontThemeDocument,
} from "@scalius/shared/storefront-theme";
import { resolveThemePreview, type ThemePreviewData } from "./api/storefront";
import { readThemePreviewCookie } from "./theme-preview-cookie";
import { storefrontLanguage, type StorefrontLanguage } from "./storefront-copy";

export interface RequestTheme {
  theme: StorefrontThemeDocument;
  /** The document resolved against the store's shape (fit fallbacks applied). */
  resolved: ResolvedStorefrontTheme;
  /** What today's components render (`resolved.layout`: card, grid, gallery...). */
  layout: ResolvedStorefrontThemeLayout;
  /** The document's brand images (logo, footer logo, favicon); null where it names none. */
  brand: StorefrontBrandAssets;
  /** The cookie's token, when the request carries one (valid or not). */
  previewToken: string | null;
  preview: ThemePreviewData | null;
  /** The store's language for the storefront's own words (lib/storefront-copy.ts). */
  language: StorefrontLanguage;
}

interface ThemeLocals {
  storefrontTheme?: Promise<RequestTheme>;
}

/**
 * The theme document the storefront renders for a value from the API.
 * Anything invalid renders `DEFAULT_STOREFRONT_THEME` whole (a fail-safe,
 * never a per-field repair).
 */
export function readStorefrontTheme(value: unknown): StorefrontThemeDocument {
  const result = storefrontThemeDocumentSchema.safeParse(value);
  if (result.success) return result.data;
  if (value !== undefined && value !== null) {
    const paths = result.error.issues
      .slice(0, 3)
      .map((issue) => issue.path.join(".") || "(root)");
    console.warn("[theme] Invalid theme document; rendering the default theme.", paths);
  }
  return DEFAULT_STOREFRONT_THEME;
}

/**
 * The store shape from the API, strictly. Anything else reads as an empty
 * store: every block then falls back to its always-fitting variant, the
 * same fail-safe as the theme itself.
 */
export function readStoreShape(value: unknown): StoreShape {
  const result = storeShapeSchema.safeParse(value);
  if (result.success) return result.data;
  if (value !== undefined && value !== null) console.warn("[theme] Invalid store shape; resolving for an empty store.");
  return EMPTY_STORE_SHAPE;
}

function readBrandAsset(value: unknown, id: string | null): StorefrontBrandAsset | null {
  if (!id || !value || typeof value !== "object") return null;
  const asset = value as Record<string, unknown>;
  const url = typeof asset.url === "string" ? asset.url.trim() : "";
  if (asset.id !== id || !url) return null;
  const size = (side: unknown) => (typeof side === "number" && Number.isFinite(side) && side > 0 ? side : null);
  return {
    id,
    url,
    alt: typeof asset.alt === "string" ? asset.alt : "",
    width: size(asset.width),
    height: size(asset.height),
  };
}

/**
 * The brand images the API resolved for a document, kept only where they are
 * the images the document names (`brand.logo`, `footerLogo`, `favicon`), so
 * a theme that renders (the default after a failed validation included)
 * never shows another document's logo. Anything else reads as no image.
 */
export function readStorefrontBrandAssets(value: unknown, brand: StorefrontThemeBrand): StorefrontBrandAssets {
  if (!value || typeof value !== "object") return EMPTY_STOREFRONT_BRAND_ASSETS;
  const assets = value as Record<string, unknown>;
  return {
    logo: readBrandAsset(assets.logo, brand.logo),
    footerLogo: readBrandAsset(assets.footerLogo, brand.footerLogo),
    favicon: readBrandAsset(assets.favicon, brand.favicon),
  };
}

/** The request theme for a theme document and store shape (also used by render tests). */
export function requestThemeFor(
  theme: StorefrontThemeDocument,
  shape: StoreShape = EMPTY_STORE_SHAPE,
  options: { previewToken?: string | null; preview?: ThemePreviewData | null; brand?: unknown; languageCode?: unknown } = {},
): RequestTheme {
  const resolved = resolveStorefrontTheme(theme, shape);
  return {
    theme,
    resolved,
    layout: resolved.layout,
    brand: readStorefrontBrandAssets(options.brand, theme.brand),
    previewToken: options.previewToken ?? null,
    preview: options.preview ?? null,
    language: storefrontLanguage(options.languageCode),
  };
}

export function resolveRequestTheme(
  astro: { request: Request; locals: object },
  layoutData: { theme?: unknown; storeShape?: unknown; brand?: unknown; storefrontCopy?: { languageCode?: unknown } | null } | null | undefined,
): Promise<RequestTheme> {
  const locals = astro.locals as ThemeLocals;
  locals.storefrontTheme ??= (async () => {
    const previewToken = readThemePreviewCookie(astro.request.headers.get("cookie")) || null;
    const preview = previewToken ? await resolveThemePreview(previewToken) : null;
    // A live preview renders the draft and its brand images; its validation
    // failing renders the default (without images), never the published
    // theme under a preview banner.
    return requestThemeFor(
      readStorefrontTheme(preview ? preview.theme : layoutData?.theme),
      readStoreShape(layoutData?.storeShape),
      {
        previewToken,
        preview,
        brand: preview ? preview.brand : layoutData?.brand,
        languageCode: layoutData?.storefrontCopy?.languageCode,
      },
    );
  })();
  return locals.storefrontTheme;
}

const DEFAULT_REQUEST_THEME = requestThemeFor(DEFAULT_STOREFRONT_THEME);

/** The request's theme once a page or the Layout resolved it; defaults otherwise. */
export async function currentRequestTheme(locals: object): Promise<RequestTheme> {
  const pending = (locals as ThemeLocals).storefrontTheme;
  return pending ? await pending : DEFAULT_REQUEST_THEME;
}
