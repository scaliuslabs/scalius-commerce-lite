import {
  createCartItemKey,
  getCartFingerprint,
  getCartRevision,
  type CartStateSnapshot,
} from "@/store/cart";

export const STOREFRONT_ASSISTANT_PAGE_CONTEXT_GLOBAL =
  "__SCALIUS_STOREFRONT_PAGE_CONTEXT__";
export const STOREFRONT_ASSISTANT_PAGE_CONTEXT_EVENT =
  "scalius:storefront-page-context:change";

export const MAX_ASSISTANT_CART_LINES = 20;
export const MAX_ASSISTANT_VISIBLE_PRODUCT_IDS = 40;
export const MAX_ASSISTANT_VISIBLE_FILTERS = 20;
const MAX_ASSISTANT_CART_LINE_COUNT = 1000;
const MAX_ASSISTANT_CART_TOTAL_ITEMS = 99999;
const MAX_ASSISTANT_CART_AMOUNT = 999999999;
const MAX_ASSISTANT_PATH_LENGTH = 512;
const MAX_ASSISTANT_URL_LENGTH = 2048;
const MAX_ASSISTANT_TITLE_LENGTH = 180;
const MAX_ASSISTANT_NAME_LENGTH = 160;
const MAX_ASSISTANT_ID_LENGTH = 120;
const MAX_ASSISTANT_OPTION_LENGTH = 80;
const MAX_ASSISTANT_QUANTITY = 9999;
const MAX_ASSISTANT_FILTER_VALUE_LENGTH = 160;
const MAX_ASSISTANT_QUERY_LENGTH = 180;
const MAX_ASSISTANT_PAGE_NUMBER = 100000;

const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const BANGLADESH_PHONE_PATTERN = /(^|[^\d])(?:\+?88)?01[3-9]\d{8}(?!\d)/g;
const BROAD_PHONE_PATTERN = /(^|[^\d])\+?\d[\d\s().-]{6,}\d(?!\d)/g;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;
const TOKEN_PREFIX_PATTERN = /\b(?:chk|cst|otp|tok|token|session|secret|sk|pk)_[A-Za-z0-9_-]{6,}\b/gi;
const SURFACE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/;
const FORBIDDEN_SURFACE_KEY_PATTERN =
  /(?:auth|bearer|code|credential|customer|email|jwt|key|mobile|otp|pass|password|phone|proof|receipt|secret|session|signature|token)/i;

const STORE_FRONT_PAGE_KINDS = [
  "home",
  "product",
  "category",
  "collection",
  "search",
  "cart",
  "checkout",
  "account",
  "page",
  "unknown",
] as const;

export type StorefrontAssistantPageKind =
  (typeof STORE_FRONT_PAGE_KINDS)[number];

export type StorefrontAssistantCartLineSummary = {
  lineKey: string;
  productId: string;
  variantId?: string;
  slug?: string;
  name: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  options?: StorefrontAssistantCartLineOption[];
};

export type StorefrontAssistantCartLineOption = {
  name: string;
  label: string;
};

export type StorefrontAssistantCartSummary = {
  revision: number;
  fingerprint: string;
  totalItems: number;
  subtotalAmount: number;
  lineCount: number;
  lines: StorefrontAssistantCartLineSummary[];
  hasDiscount: boolean;
  truncated: boolean;
};

export type StorefrontAssistantSelectedOption = {
  name: string;
  label: string;
};

export type StorefrontAssistantProductAvailability =
  | "in_stock"
  | "out_of_stock"
  | "selection_required"
  | "unavailable";

export type StorefrontAssistantProductSurface = {
  kind: "product";
  productId: string;
  slug?: string;
  selectedVariantId?: string;
  selectedOptions: StorefrontAssistantSelectedOption[];
  displayedPrice: number;
  availability: StorefrontAssistantProductAvailability;
};

export type StorefrontAssistantVisibleFilter = {
  key: string;
  value: string;
};

type StorefrontAssistantListingSurfaceBase = {
  visibleProductIds: string[];
  visibleFilters: StorefrontAssistantVisibleFilter[];
  totalResults: number;
  page: number;
  sortBy?: string;
};

export type StorefrontAssistantCategorySurface =
  StorefrontAssistantListingSurfaceBase & {
    kind: "category";
    categoryId: string;
    slug: string;
  };

export type StorefrontAssistantCollectionSurface =
  StorefrontAssistantListingSurfaceBase & {
    kind: "collection";
    collectionId: string;
  };

export type StorefrontAssistantSearchSurface =
  StorefrontAssistantListingSurfaceBase & {
    kind: "search";
    query: string;
  };

export type StorefrontAssistantCartSurface = {
  kind: "cart";
  revision: number;
  fingerprint: string;
  exactLineKeys: string[];
  totalItems: number;
  lineCount: number;
};

export type StorefrontAssistantSurfaceContext =
  | StorefrontAssistantProductSurface
  | StorefrontAssistantCategorySurface
  | StorefrontAssistantCollectionSurface
  | StorefrontAssistantSearchSurface
  | StorefrontAssistantCartSurface;

export type StorefrontAssistantPageContextSnapshot = {
  /** Existing public chat envelope version. */
  version: 1;
  /** Typed buyer-surface/cart context contract introduced by this slice. */
  contextVersion: 2;
  source: "storefront";
  page: {
    path: string;
    route: string | null;
    canonicalUrl: string | null;
    title: string;
    kind: StorefrontAssistantPageKind;
  };
  cart: StorefrontAssistantCartSummary;
  surface: StorefrontAssistantSurfaceContext | null;
};

export type StorefrontAssistantPageContextInput = {
  path?: string | null;
  route?: string | null;
  canonicalUrl?: string | null;
  title?: string | null;
  pageKind?: StorefrontAssistantPageKind | null;
  cart?: CartStateSnapshot | null;
  surface?: StorefrontAssistantSurfaceContext | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clampNumber(value: unknown, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  const clamped = Math.min(Math.max(value, 0), max);
  return Math.round(clamped * 100) / 100;
}

function clampQuantity(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.min(Math.max(Math.floor(value), 0), MAX_ASSISTANT_QUANTITY);
}

function replaceControlCharacters(value: string): string {
  return Array.from(value, (char) => {
    const code = char.charCodeAt(0);
    return code <= 31 || code === 127 ? " " : char;
  }).join("");
}

function redactSensitiveText(value: string): string {
  return value
    .replace(BEARER_PATTERN, "Bearer [redacted-token]")
    .replace(EMAIL_PATTERN, "[redacted-email]")
    .replace(BANGLADESH_PHONE_PATTERN, "$1[redacted-phone]")
    .replace(BROAD_PHONE_PATTERN, "$1[redacted-number]")
    .replace(TOKEN_PREFIX_PATTERN, "[redacted-token]");
}

function cleanText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const cleaned = replaceControlCharacters(value)
    .replace(/[\u2028\u2029]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;
  return redactSensitiveText(cleaned).slice(0, maxLength);
}

function cleanPath(value: unknown): string {
  const text = cleanText(value, MAX_ASSISTANT_PATH_LENGTH);
  if (!text) return "/";

  let path = text;
  try {
    if (/^https?:\/\//i.test(path)) {
      path = new URL(path).pathname;
    }
  } catch {
    path = "/";
  }

  path = path.split(/[?#]/, 1)[0]?.replace(/\\/g, "/") || "/";
  path = path.replace(/\/{2,}/g, "/");
  if (!path.startsWith("/")) path = `/${path}`;

  return redactSensitivePath(path.slice(0, MAX_ASSISTANT_PATH_LENGTH));
}

function redactSensitivePath(path: string): string {
  if (/^\/account\/orders\/[^/]+(?:\/.*)?$/i.test(path)) {
    return "/account/orders/[id]";
  }
  if (/^\/orders\/status\/[^/]+(?:\/.*)?$/i.test(path)) {
    return "/orders/status/[token]";
  }
  if (/^\/api\/orders\/status\/[^/]+(?:\/.*)?$/i.test(path)) {
    return "/api/orders/status/[token]";
  }
  if (/^\/api\/orders\/receipt\/[^/]+(?:\/.*)?$/i.test(path)) {
    return "/api/orders/receipt/[id]";
  }
  return path;
}

function cleanRoute(value: unknown): string | null {
  const route = cleanText(value, MAX_ASSISTANT_PATH_LENGTH);
  return route ? cleanPath(route) : null;
}

function cleanCanonicalUrl(value: unknown): string | null {
  const text = cleanText(value, MAX_ASSISTANT_URL_LENGTH);
  if (!text) return null;

  try {
    const url = new URL(text);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (redactSensitivePath(url.pathname) !== url.pathname) return null;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.href.slice(0, MAX_ASSISTANT_URL_LENGTH);
  } catch {
    return null;
  }
}

function isPageKind(value: unknown): value is StorefrontAssistantPageKind {
  return (
    typeof value === "string" &&
    STORE_FRONT_PAGE_KINDS.includes(value as StorefrontAssistantPageKind)
  );
}

export function inferStorefrontAssistantPageKind(
  path: string,
  route?: string | null,
): StorefrontAssistantPageKind {
  const source = (route || path || "/").toLowerCase();

  if (source === "/") return "home";
  if (source.startsWith("/products/")) return "product";
  if (source.startsWith("/categories/")) return "category";
  if (source.startsWith("/collections/")) return "collection";
  if (source === "/search" || source.startsWith("/search/")) return "search";
  if (source === "/cart") return "cart";
  if (
    source === "/checkout" ||
    source === "/order-success" ||
    source === "/payment-recovery" ||
    source.startsWith("/buy/")
  ) {
    return "checkout";
  }
  if (source === "/account" || source.startsWith("/account/")) {
    return "account";
  }
  if (source === "/[slug]" || source.startsWith("/pages/")) return "page";

  return "unknown";
}

export function emptyStorefrontAssistantCartSummary(): StorefrontAssistantCartSummary {
  return {
    revision: 0,
    fingerprint: getCartFingerprint(null),
    totalItems: 0,
    subtotalAmount: 0,
    lineCount: 0,
    lines: [],
    hasDiscount: false,
    truncated: false,
  };
}

function cleanCartLine(
  value: unknown,
  storedLineKey?: string,
): StorefrontAssistantCartLineSummary | null {
  if (!isRecord(value)) return null;

  const productId = cleanText(value.id, MAX_ASSISTANT_ID_LENGTH);
  const name = cleanText(value.name, MAX_ASSISTANT_NAME_LENGTH);
  if (!productId || !name) return null;

  const quantity = clampQuantity(value.quantity);
  if (quantity <= 0) return null;

  const unitPrice = clampNumber(value.price, MAX_ASSISTANT_CART_AMOUNT);
  const lineTotal = clampNumber(unitPrice * quantity, MAX_ASSISTANT_CART_AMOUNT);
  const variantId = cleanText(value.variantId, MAX_ASSISTANT_ID_LENGTH);
  if (!variantId || variantId === "default") return null;
  const slug = cleanText(value.slug, MAX_ASSISTANT_ID_LENGTH);
  const options = cleanCartLineOptions(value);
  const computedLineKey = createCartItemKey({
    id: productId,
    variantId,
  });
  const cleanedStoredLineKey = cleanText(
    storedLineKey,
    MAX_ASSISTANT_PATH_LENGTH,
  );
  const lineKey =
    cleanedStoredLineKey === storedLineKey &&
    cleanedStoredLineKey?.startsWith("line:v2:")
      ? cleanedStoredLineKey
      : computedLineKey;

  return {
    lineKey,
    productId,
    variantId,
    ...(slug ? { slug } : {}),
    name,
    quantity,
    unitPrice,
    lineTotal,
    ...(options ? { options } : {}),
  };
}

function cleanCartLineOption(value: unknown): StorefrontAssistantCartLineOption | null {
  if (!isRecord(value)) return null;

  const name = cleanText(value.name, MAX_ASSISTANT_OPTION_LENGTH);
  const label = cleanText(value.label, MAX_ASSISTANT_OPTION_LENGTH);
  if (!name || !label) return null;

  return { name, label };
}

function cleanCartLineOptions(
  value: Record<string, unknown>,
): StorefrontAssistantCartLineOption[] | undefined {
  if (Array.isArray(value.options)) {
    const options = value.options
      .slice(0, 2)
      .map(cleanCartLineOption)
      .filter((option): option is StorefrontAssistantCartLineOption =>
        Boolean(option),
      );
    if (options.length > 0) return options;
  }

  const legacyOptions = [
    { name: "Option 1", label: value.size },
    { name: "Option 2", label: value.color },
  ]
    .map(cleanCartLineOption)
    .filter((option): option is StorefrontAssistantCartLineOption =>
      Boolean(option),
    );

  return legacyOptions.length > 0 ? legacyOptions : undefined;
}

export function buildStorefrontAssistantCartSummary(
  cart: CartStateSnapshot | null | undefined,
): StorefrontAssistantCartSummary {
  if (!cart || !isRecord(cart.items)) {
    return emptyStorefrontAssistantCartSummary();
  }

  const lines: StorefrontAssistantCartLineSummary[] = [];
  let lineCount = 0;
  let totalItems = 0;
  let subtotalAmount = 0;

  for (const [storedLineKey, value] of Object.entries(cart.items)) {
    const line = cleanCartLine(value, storedLineKey);
    if (!line) continue;

    lineCount += 1;
    totalItems = Math.min(
      totalItems + line.quantity,
      MAX_ASSISTANT_CART_TOTAL_ITEMS,
    );
    subtotalAmount = Math.min(
      subtotalAmount + line.lineTotal,
      MAX_ASSISTANT_CART_AMOUNT,
    );

    if (lines.length < MAX_ASSISTANT_CART_LINES) {
      lines.push(line);
    }
  }

  return {
    revision: getCartRevision(cart),
    fingerprint: getCartFingerprint(cart),
    totalItems,
    subtotalAmount: Math.round(subtotalAmount * 100) / 100,
    lineCount: Math.min(lineCount, MAX_ASSISTANT_CART_LINE_COUNT),
    lines,
    hasDiscount: isRecord(cart.discount),
    truncated: lineCount > lines.length,
  };
}

function cleanSurfaceText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const compacted = replaceControlCharacters(value)
    .replace(/[\u2028\u2029]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!compacted || compacted.length > maxLength) return null;
  return redactSensitiveText(compacted) === compacted ? compacted : null;
}

function cleanIdentifier(value: unknown): string | null {
  const identifier = cleanSurfaceText(value, MAX_ASSISTANT_ID_LENGTH);
  return identifier && SURFACE_IDENTIFIER_PATTERN.test(identifier)
    ? identifier
    : null;
}

function cleanVisibleProductIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  for (const candidate of value) {
    const id = cleanIdentifier(candidate);
    if (id) ids.add(id);
    if (ids.size >= MAX_ASSISTANT_VISIBLE_PRODUCT_IDS) break;
  }
  return Array.from(ids);
}

function cleanExactLineKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const keys = new Set<string>();
  for (const candidate of value) {
    const key = cleanSurfaceText(candidate, MAX_ASSISTANT_PATH_LENGTH);
    if (key?.startsWith("line:v2:")) keys.add(key);
    if (keys.size >= MAX_ASSISTANT_CART_LINES) break;
  }
  return Array.from(keys);
}

function cleanVisibleFilters(value: unknown): StorefrontAssistantVisibleFilter[] {
  if (!Array.isArray(value)) return [];
  const filters = new Map<string, string>();
  for (const candidate of value) {
    if (!isRecord(candidate)) continue;
    const key = cleanSurfaceText(candidate.key, MAX_ASSISTANT_OPTION_LENGTH);
    const filterValue = cleanSurfaceText(
      candidate.value,
      MAX_ASSISTANT_FILTER_VALUE_LENGTH,
    );
    if (!key || !filterValue || FORBIDDEN_SURFACE_KEY_PATTERN.test(key)) {
      continue;
    }
    filters.set(key, filterValue);
    if (filters.size >= MAX_ASSISTANT_VISIBLE_FILTERS) break;
  }
  return Array.from(filters, ([key, filterValue]) => ({
    key,
    value: filterValue,
  })).sort((left, right) =>
    left.key < right.key ? -1 : left.key > right.key ? 1 : 0,
  );
}

function cleanListingSurface(value: Record<string, unknown>) {
  const sortBy = cleanSurfaceText(value.sortBy, MAX_ASSISTANT_OPTION_LENGTH);
  return {
    visibleProductIds: cleanVisibleProductIds(value.visibleProductIds),
    visibleFilters: cleanVisibleFilters(value.visibleFilters),
    totalResults: Math.floor(
      clampNumber(value.totalResults, MAX_ASSISTANT_CART_TOTAL_ITEMS),
    ),
    page: Math.max(
      1,
      Math.floor(clampNumber(value.page, MAX_ASSISTANT_PAGE_NUMBER)) || 1,
    ),
    ...(sortBy ? { sortBy } : {}),
  };
}

function cleanProductSurface(
  value: Record<string, unknown>,
): StorefrontAssistantProductSurface | null {
  const productId = cleanIdentifier(value.productId);
  if (
    !productId ||
    typeof value.displayedPrice !== "number" ||
    !Number.isFinite(value.displayedPrice) ||
    value.displayedPrice < 0
  ) {
    return null;
  }
  const availability = value.availability;
  if (
    availability !== "in_stock" &&
    availability !== "out_of_stock" &&
    availability !== "selection_required" &&
    availability !== "unavailable"
  ) {
    return null;
  }

  const selectedOptions: StorefrontAssistantSelectedOption[] = [];
  if (Array.isArray(value.selectedOptions)) {
    for (const option of value.selectedOptions.slice(0, 2)) {
      if (!isRecord(option)) continue;
      const name = cleanSurfaceText(option.name, MAX_ASSISTANT_OPTION_LENGTH);
      const label = cleanSurfaceText(option.label, MAX_ASSISTANT_OPTION_LENGTH);
      if (!name || !label || FORBIDDEN_SURFACE_KEY_PATTERN.test(name)) continue;
      selectedOptions.push({ name, label });
    }
  }
  const slug = cleanIdentifier(value.slug);
  const selectedVariantId = cleanIdentifier(value.selectedVariantId);
  return {
    kind: "product",
    productId,
    ...(slug ? { slug } : {}),
    ...(selectedVariantId ? { selectedVariantId } : {}),
    selectedOptions,
    displayedPrice: clampNumber(value.displayedPrice, MAX_ASSISTANT_CART_AMOUNT),
    availability,
  };
}

export function normalizeStorefrontAssistantSurfaceContext(
  value: unknown,
  expectedKind?: StorefrontAssistantPageKind | null,
): StorefrontAssistantSurfaceContext | null {
  if (!isRecord(value) || typeof value.kind !== "string") return null;
  if (expectedKind && value.kind !== expectedKind) return null;

  if (value.kind === "product") return cleanProductSurface(value);
  if (value.kind === "category") {
    const categoryId = cleanIdentifier(value.categoryId);
    const slug = cleanIdentifier(value.slug);
    if (!categoryId || !slug) return null;
    return {
      kind: "category",
      categoryId,
      slug,
      ...cleanListingSurface(value),
    };
  }
  if (value.kind === "collection") {
    const collectionId = cleanIdentifier(value.collectionId);
    if (!collectionId) return null;
    return {
      kind: "collection",
      collectionId,
      ...cleanListingSurface(value),
    };
  }
  if (value.kind === "search") {
    const query = cleanSurfaceText(value.query, MAX_ASSISTANT_QUERY_LENGTH) ?? "";
    return {
      kind: "search",
      query,
      ...cleanListingSurface(value),
    };
  }
  if (value.kind === "cart") {
    const revision =
      typeof value.revision === "number" &&
      Number.isSafeInteger(value.revision) &&
      value.revision >= 0
        ? value.revision
        : 0;
    const fingerprint = cleanText(value.fingerprint, 32);
    if (!fingerprint || !/^cart_v1_[a-f0-9]{8}$/.test(fingerprint)) return null;
    return {
      kind: "cart",
      revision,
      fingerprint,
      exactLineKeys: cleanExactLineKeys(value.exactLineKeys),
      totalItems: Math.floor(
        clampNumber(value.totalItems, MAX_ASSISTANT_CART_TOTAL_ITEMS),
      ),
      lineCount: Math.floor(
        clampNumber(value.lineCount, MAX_ASSISTANT_CART_LINE_COUNT),
      ),
    };
  }

  return null;
}

function buildCartSurface(
  cart: StorefrontAssistantCartSummary,
): StorefrontAssistantCartSurface {
  return {
    kind: "cart",
    revision: cart.revision,
    fingerprint: cart.fingerprint,
    exactLineKeys: cart.lines.map((line) => line.lineKey),
    totalItems: cart.totalItems,
    lineCount: cart.lineCount,
  };
}

export function buildStorefrontAssistantPageContext(
  input: StorefrontAssistantPageContextInput = {},
): StorefrontAssistantPageContextSnapshot {
  const path = cleanPath(input.path);
  const route = cleanRoute(input.route);
  const kind = isPageKind(input.pageKind)
    ? input.pageKind
    : inferStorefrontAssistantPageKind(path, route);
  const cart = buildStorefrontAssistantCartSummary(input.cart);
  const surface =
    kind === "cart"
      ? buildCartSurface(cart)
      : normalizeStorefrontAssistantSurfaceContext(input.surface, kind);

  return {
    version: 1,
    contextVersion: 2,
    source: "storefront",
    page: {
      path,
      route,
      canonicalUrl: cleanCanonicalUrl(input.canonicalUrl),
      title: cleanText(input.title, MAX_ASSISTANT_TITLE_LENGTH) ?? "",
      kind,
    },
    cart,
    surface,
  };
}
