import type { CartStore } from "@/store/cart";

export const STOREFRONT_ASSISTANT_PAGE_CONTEXT_GLOBAL =
  "__SCALIUS_STOREFRONT_PAGE_CONTEXT__";
export const STOREFRONT_ASSISTANT_PAGE_CONTEXT_EVENT =
  "scalius:storefront-page-context:change";

export const MAX_ASSISTANT_CART_LINES = 20;
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

const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const BANGLADESH_PHONE_PATTERN = /(^|[^\d])(?:\+?88)?01[3-9]\d{8}(?!\d)/g;
const BROAD_PHONE_PATTERN = /(^|[^\d])\+?\d[\d\s().-]{6,}\d(?!\d)/g;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;
const TOKEN_PREFIX_PATTERN = /\b(?:chk|cst|otp|tok|token|session|secret|sk|pk)_[A-Za-z0-9_-]{6,}\b/gi;

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
  totalItems: number;
  subtotalAmount: number;
  lineCount: number;
  lines: StorefrontAssistantCartLineSummary[];
  hasDiscount: boolean;
  truncated: boolean;
};

export type StorefrontAssistantPageContextSnapshot = {
  version: 1;
  source: "storefront";
  page: {
    path: string;
    route: string | null;
    canonicalUrl: string | null;
    title: string;
    kind: StorefrontAssistantPageKind;
  };
  cart: StorefrontAssistantCartSummary;
};

export type StorefrontAssistantPageContextInput = {
  path?: string | null;
  route?: string | null;
  canonicalUrl?: string | null;
  title?: string | null;
  pageKind?: StorefrontAssistantPageKind | null;
  cart?: CartStore | null;
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
    totalItems: 0,
    subtotalAmount: 0,
    lineCount: 0,
    lines: [],
    hasDiscount: false,
    truncated: false,
  };
}

function cleanCartLine(value: unknown): StorefrontAssistantCartLineSummary | null {
  if (!isRecord(value)) return null;

  const productId = cleanText(value.id, MAX_ASSISTANT_ID_LENGTH);
  const name = cleanText(value.name, MAX_ASSISTANT_NAME_LENGTH);
  if (!productId || !name) return null;

  const quantity = clampQuantity(value.quantity);
  if (quantity <= 0) return null;

  const unitPrice = clampNumber(value.price, MAX_ASSISTANT_CART_AMOUNT);
  const lineTotal = clampNumber(unitPrice * quantity, MAX_ASSISTANT_CART_AMOUNT);
  const variantId = cleanText(value.variantId, MAX_ASSISTANT_ID_LENGTH);
  const slug = cleanText(value.slug, MAX_ASSISTANT_ID_LENGTH);
  const options = cleanCartLineOptions(value);

  return {
    productId,
    ...(variantId ? { variantId } : {}),
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
  cart: CartStore | null | undefined,
): StorefrontAssistantCartSummary {
  if (!cart || !isRecord(cart.items)) {
    return emptyStorefrontAssistantCartSummary();
  }

  const lines: StorefrontAssistantCartLineSummary[] = [];
  let lineCount = 0;
  let totalItems = 0;
  let subtotalAmount = 0;

  for (const value of Object.values(cart.items)) {
    const line = cleanCartLine(value);
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
    totalItems,
    subtotalAmount: Math.round(subtotalAmount * 100) / 100,
    lineCount: Math.min(lineCount, MAX_ASSISTANT_CART_LINE_COUNT),
    lines,
    hasDiscount: isRecord(cart.discount),
    truncated: lineCount > lines.length,
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

  return {
    version: 1,
    source: "storefront",
    page: {
      path,
      route,
      canonicalUrl: cleanCanonicalUrl(input.canonicalUrl),
      title: cleanText(input.title, MAX_ASSISTANT_TITLE_LENGTH) ?? "",
      kind,
    },
    cart: buildStorefrontAssistantCartSummary(input.cart),
  };
}
