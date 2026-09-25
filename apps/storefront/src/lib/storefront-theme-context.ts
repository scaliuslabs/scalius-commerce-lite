/**
 * The theme a request renders with: the published theme, or the merchant's
 * draft while a dashboard theme preview cookie is active, resolved against
 * the store's shape with the same resolver the dashboard uses. Resolved once
 * per request and shared through `locals`, so pages (homepage sections,
 * product layout), the Layout and every product card agree without extra
 * reads.
 */
import {
  DEFAULT_STOREFRONT_THEME,
  EMPTY_STORE_SHAPE,
  resolveStorefrontTheme,
  storeShapeSchema,
  storefrontThemeDocumentSchema,
  type ResolvedStorefrontTheme,
  type ResolvedStorefrontThemeLayout,
  type StoreShape,
  type StorefrontThemeDocument,
} from "@scalius/shared/storefront-theme";
import { resolveThemePreview, type ThemePreviewData } from "./api/storefront";
import { readThemePreviewCookie } from "./theme-preview-cookie";

export interface RequestTheme {
  theme: StorefrontThemeDocument;
  /** The document resolved against the store's shape (fit fallbacks applied). */
  resolved: ResolvedStorefrontTheme;
  /** What today's components render (`resolved.layout`: card, grid, gallery...). */
  layout: ResolvedStorefrontThemeLayout;
  /** The cookie's token, when the request carries one (valid or not). */
  previewToken: string | null;
  preview: ThemePreviewData | null;
}

interface ThemeLocals {
  storefrontTheme?: Promise<RequestTheme>;
}

/**
 * The theme document the storefront renders for a value from the API. The
 * value must pass the strict v5 schema; anything else renders
 * `DEFAULT_STOREFRONT_THEME` whole (a fail-safe, never a per-field repair).
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

/** The request theme for a theme document and store shape (also used by render tests). */
export function requestThemeFor(
  theme: StorefrontThemeDocument,
  shape: StoreShape = EMPTY_STORE_SHAPE,
  preview: { previewToken: string | null; preview: ThemePreviewData | null } = {
    previewToken: null,
    preview: null,
  },
): RequestTheme {
  const resolved = resolveStorefrontTheme(theme, shape);
  return { theme, resolved, layout: resolved.layout, ...preview };
}

export function resolveRequestTheme(
  astro: { request: Request; locals: object },
  layoutData: { theme?: unknown; storeShape?: unknown } | null | undefined,
): Promise<RequestTheme> {
  const locals = astro.locals as ThemeLocals;
  locals.storefrontTheme ??= (async () => {
    const previewToken = readThemePreviewCookie(astro.request.headers.get("cookie")) || null;
    const preview = previewToken ? await resolveThemePreview(previewToken) : null;
    // A live preview renders the draft; its validation failing renders the
    // default, never the published theme under a preview banner.
    return requestThemeFor(
      readStorefrontTheme(preview ? preview.theme : layoutData?.theme),
      readStoreShape(layoutData?.storeShape),
      { previewToken, preview },
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
