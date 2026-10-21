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
  STOREFRONT_SKIN_IMAGES_MAX,
  storefrontThemeSkinMediaCandidates,
  resolveStorefrontTheme,
  resolveDocumentBindings,
  hasSettingBindings,
  storeShapeSchema,
  storefrontThemeDocumentSchema,
  type ResolvedStorefrontTheme,
  type ResolvedStorefrontThemeLayout,
  type StoreShape,
  type StorefrontBrandAsset,
  type StorefrontBrandAssets,
  type StorefrontThemeBrand,
  type StorefrontThemeDocument,
  type SettingBindingContext,
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
  /** Images the document's unit skins name, by media id (`readSkinMedia`). */
  skinMedia: ReadonlyMap<string, StorefrontBrandAsset>;
  /** The cookie's token, when the request carries one (valid or not). */
  previewToken: string | null;
  preview: ThemePreviewData | null;
  /** The store's language for the storefront's own words (lib/storefront-copy.ts). */
  language: StorefrontLanguage;
  bindingContext: SettingBindingContext;
  shape: StoreShape;
  /** The page renders the default in place of an unreadable document: never shared-cached. */
  degraded: boolean;
}

interface ThemeLocals {
  storefrontTheme?: Promise<RequestTheme>;
}

export interface StorefrontThemeRead {
  theme: StorefrontThemeDocument;
  /**
   * The API sent a document this storefront cannot read (a newer theme
   * version during an API-first deploy, or a bad document): the page renders
   * the default theme, so it must never enter the shared page cache.
   */
  degraded: boolean;
}

/** The one failure signature this isolate last reported (a log dedupe hint only). */
let reportedThemeFailure: string | null = null;

/**
 * The theme document the storefront renders for a value from the API.
 * Anything invalid renders `DEFAULT_STOREFRONT_THEME` whole (a fail-safe,
 * never a per-field repair) and reads as degraded. The failure is logged
 * once per isolate and signature, masked: the document's declared version
 * and the failing schema paths (indexes elided), never a value.
 */
export function readStorefrontThemeDocument(value: unknown): StorefrontThemeRead {
  const result = storefrontThemeDocumentSchema.safeParse(value);
  if (result.success) return { theme: result.data, degraded: false };
  if (value === undefined || value === null) return { theme: DEFAULT_STOREFRONT_THEME, degraded: false };
  const version = (value as { version?: unknown }).version;
  const declared = typeof version === "number" && Number.isSafeInteger(version) ? version : null;
  const paths = result.error.issues
    .slice(0, 3)
    .map((issue) => issue.path.map((part) => (typeof part === "number" ? "#" : String(part).slice(0, 40))).join(".") || "(root)");
  const signature = `${declared}:${paths.join(",")}`;
  if (signature !== reportedThemeFailure) {
    reportedThemeFailure = signature;
    console.warn("[theme] Unreadable theme document; rendering the default theme uncached.", {
      version: declared,
      expected: DEFAULT_STOREFRONT_THEME.version,
      paths,
    });
  }
  return { theme: DEFAULT_STOREFRONT_THEME, degraded: true };
}

/** The theme document a value renders (see `readStorefrontThemeDocument`). */
export function readStorefrontTheme(value: unknown): StorefrontThemeDocument {
  return readStorefrontThemeDocument(value).theme;
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

/**
 * The images the API resolved for a document's unit skins, by media id,
 * kept only where the document's skins name them (so a default theme drawn
 * after a failed validation shows none). Each app's schema says which of
 * a skin's values are images (lib/extensions `appSkin`).
 */
export function readSkinMedia(value: unknown, theme: StorefrontThemeDocument): ReadonlyMap<string, StorefrontBrandAsset> {
  if (!Array.isArray(value) || value.length === 0) return new Map();
  const named = new Set(storefrontThemeSkinMediaCandidates(theme.apps?.skins));
  const assets = new Map<string, StorefrontBrandAsset>();
  for (const entry of value.slice(0, STOREFRONT_SKIN_IMAGES_MAX)) {
    const id = entry && typeof entry === "object" ? (entry as { id?: unknown }).id : undefined;
    const asset = typeof id === "string" && named.has(id) ? readBrandAsset(entry, id) : null;
    if (asset) assets.set(asset.id, asset);
  }
  return assets;
}

/** The request theme for a theme document and store shape (also used by render tests). */
export function requestThemeFor(
  theme: StorefrontThemeDocument,
  shape: StoreShape = EMPTY_STORE_SHAPE,
  options: { previewToken?: string | null; preview?: ThemePreviewData | null; brand?: unknown; skinMedia?: unknown; languageCode?: unknown; bindings?: SettingBindingContext; degraded?: boolean } = {},
): RequestTheme {
  const bindingContext = { language: storefrontLanguage(options.languageCode), ...options.bindings };
  theme = boundTheme(theme, bindingContext);
  const resolved = resolveStorefrontTheme(theme, shape);
  return {
    theme,
    resolved,
    layout: resolved.layout,
    brand: readStorefrontBrandAssets(options.brand, theme.brand),
    skinMedia: readSkinMedia(options.skinMedia, theme),
    previewToken: options.previewToken ?? null,
    preview: options.preview ?? null,
    language: storefrontLanguage(options.languageCode),
    bindingContext,
    shape,
    degraded: options.degraded ?? false,
  };
}

export function resolveRequestTheme(
  astro: { request: Request; locals: object },
  layoutData: { theme?: unknown; storeShape?: unknown; brand?: unknown; skinMedia?: unknown; storefrontCopy?: { languageCode?: unknown } | null } | null | undefined,
  bindings?: SettingBindingContext,
): Promise<RequestTheme> {
  const locals = astro.locals as ThemeLocals;
  locals.storefrontTheme ??= (async () => {
    const previewToken = readThemePreviewCookie(astro.request.headers.get("cookie")) || null;
    const preview = previewToken ? await resolveThemePreview(previewToken) : null;
    // A live preview renders the draft and its brand images; its validation
    // failing renders the default (without images), never the published
    // theme under a preview banner.
    const read = readStorefrontThemeDocument(preview ? preview.theme : layoutData?.theme);
    return requestThemeFor(
      read.theme,
      readStoreShape(layoutData?.storeShape),
      {
        degraded: read.degraded,
        previewToken,
        preview,
        brand: preview ? preview.brand : layoutData?.brand,
        skinMedia: preview ? preview.skinMedia : layoutData?.skinMedia,
        languageCode: layoutData?.storefrontCopy?.languageCode,
        bindings,
      },
    );
  })();
  return locals.storefrontTheme;
}

/**
 * Whether an HTML response drew the default theme because the API sent a
 * document this storefront cannot read. The request's one theme resolution
 * is shared with the page (resolved here first when the Layout has not yet),
 * so this reads the same document the HTML renders. A resolution that throws
 * reads as degraded: the page is then never shared-cached.
 */
export async function pageRendersDegradedTheme(
  astro: { request: Request; locals: object },
  response: Response,
  layoutData: Parameters<typeof resolveRequestTheme>[1],
): Promise<boolean> {
  if (!response.headers.get("Content-Type")?.toLowerCase().includes("text/html")) return false;
  try {
    return (await resolveRequestTheme(astro, layoutData)).degraded;
  } catch {
    return true;
  }
}

/** Object data joins the existing page part after the layout resolves. */
export function applyRequestThemeBindings(requestTheme: RequestTheme, bindings: SettingBindingContext): void {
  requestTheme.bindingContext = { ...requestTheme.bindingContext, ...bindings };
  requestTheme.theme = boundTheme(requestTheme.theme, requestTheme.bindingContext);
  requestTheme.resolved = resolveStorefrontTheme(requestTheme.theme, requestTheme.shape);
  requestTheme.layout = requestTheme.resolved.layout;
}

function boundTheme(theme: StorefrontThemeDocument, context: SettingBindingContext): StorefrontThemeDocument {
  if (!hasSettingBindings(theme)) return theme;
  const bound = storefrontThemeDocumentSchema.safeParse(resolveDocumentBindings(theme, context, storefrontThemeDocumentSchema));
  return bound.success ? bound.data : theme;
}

const DEFAULT_REQUEST_THEME = requestThemeFor(DEFAULT_STOREFRONT_THEME);

/** The request's theme once a page or the Layout resolved it; defaults otherwise. */
export async function currentRequestTheme(locals: object): Promise<RequestTheme> {
  const pending = (locals as ThemeLocals).storefrontTheme;
  return pending ? await pending : DEFAULT_REQUEST_THEME;
}
