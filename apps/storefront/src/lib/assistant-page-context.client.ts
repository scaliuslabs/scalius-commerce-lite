import { cartStore } from "@/store/cart";

import {
  STOREFRONT_ASSISTANT_PAGE_CONTEXT_EVENT,
  STOREFRONT_ASSISTANT_PAGE_CONTEXT_GLOBAL,
  buildStorefrontAssistantPageContext,
  inferStorefrontAssistantPageKind,
  normalizeStorefrontAssistantSurfaceContext,
  type StorefrontAssistantPageContextSnapshot,
  type StorefrontAssistantSurfaceContext,
} from "./assistant-page-context";

export const STOREFRONT_ASSISTANT_BRIDGE_GLOBAL =
  "__SCALIUS_STOREFRONT_ASSISTANT__";

type StorefrontAssistantBridge = {
  getContext: () => StorefrontAssistantPageContextSnapshot | null;
  navigate: (target: unknown) => boolean;
};

declare global {
  interface Window {
    __SCALIUS_STOREFRONT_PAGE_CONTEXT__?: StorefrontAssistantPageContextSnapshot;
    __SCALIUS_STOREFRONT_ASSISTANT__?: StorefrontAssistantBridge;
  }

  interface WindowEventMap {
    "scalius:storefront-page-context:change": CustomEvent<StorefrontAssistantPageContextSnapshot>;
  }
}

let installed = false;
let publishQueued = false;
let pageSeed: StorefrontAssistantPageContextSnapshot | null = null;
let registeredSurface: {
  token: symbol;
  path: string;
  surface: StorefrontAssistantSurfaceContext;
} | null = null;

export type StorefrontAssistantSurfaceRegistration = {
  update: (surface: StorefrontAssistantSurfaceContext) => boolean;
  unregister: () => void;
};

const MAX_ASSISTANT_NAVIGATION_TARGET_LENGTH = 2048;
const MAX_ASSISTANT_NAVIGATION_QUERY_LENGTH = 512;
const MAX_ASSISTANT_NAVIGATION_QUERY_PAIRS = 20;
const MAX_ASSISTANT_NAVIGATION_QUERY_KEY_LENGTH = 64;
const MAX_ASSISTANT_NAVIGATION_QUERY_VALUE_LENGTH = 180;
const MAX_ASSISTANT_NAVIGATION_PATH_SEGMENT_LENGTH = 160;

const SAFE_PATH_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/;
const SAFE_QUERY_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;
const EMAIL_QUERY_VALUE_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const BANGLADESH_PHONE_QUERY_VALUE_PATTERN =
  /(^|[^\d])(?:\+?88)?01[3-9]\d{8}(?!\d)/;
const BROAD_PHONE_QUERY_VALUE_PATTERN = /(^|[^\d])\+?\d[\d\s().-]{6,}\d(?!\d)/;
const SENSITIVE_QUERY_NAME_PATTERN =
  /(?:bearer|credential|jwt|otp|password|passwd|proof|receipt|secret|session|signature|token)/i;
const TOKEN_LIKE_QUERY_VALUE_PATTERN =
  /(?:\bBearer\s+|(?:chk|cst|otp|tok|token|session|secret|sk|pk)_[A-Za-z0-9_-]{6,}|[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]{10,})?|[A-Fa-f0-9]{32,})/i;
const RAW_PATH_TRAVERSAL_PATTERN = /(^|\/)\.{1,2}(?:\/|$|[?#])/;
const ENCODED_UNSAFE_PATH_PATTERN = /%(?:2e|2f|5c)/i;

const BLOCKED_BUYER_PATH_SEGMENTS = new Set([
  "account",
  "admin",
  "api",
  "auth",
  "buy",
  "checkout",
  "order",
  "order-success",
  "orders",
  "payment",
  "payment-recovery",
  "private",
  "receipt",
  "receipts",
  "status",
]);

const RESERVED_CMS_PAGE_SLUGS = new Set([
  ...BLOCKED_BUYER_PATH_SEGMENTS,
  "cart",
  "categories",
  "collections",
  "products",
  "search",
]);

const SENSITIVE_QUERY_NAMES = new Set([
  "auth",
  "code",
  "customer",
  "email",
  "key",
  "mobile",
  "pass",
  "phone",
  "sig",
]);

function readCanonicalFromDocument(): string | null {
  if (typeof document === "undefined") return null;
  const canonical = document.querySelector<HTMLLinkElement>(
    'link[rel="canonical"]',
  );
  return canonical?.href || canonical?.getAttribute("href") || null;
}

function readMatchingSeed(): StorefrontAssistantPageContextSnapshot | null {
  const candidate = window.__SCALIUS_STOREFRONT_PAGE_CONTEXT__;
  if (candidate && !Object.isFrozen(candidate)) pageSeed = candidate;
  const seed = pageSeed?.page;
  if (!seed || !pageSeed) return null;

  const current = buildStorefrontAssistantPageContext({
    path: window.location.pathname,
  });
  return seed.path === current.page.path ? pageSeed : null;
}

function readRegisteredSurface(): StorefrontAssistantSurfaceContext | null {
  if (!registeredSurface) return null;
  const currentPath = buildStorefrontAssistantPageContext({
    path: window.location.pathname,
  }).page.path;
  return registeredSurface.path === currentPath
    ? registeredSurface.surface
    : null;
}

function readBrowserSnapshot(): StorefrontAssistantPageContextSnapshot {
  const seed = readMatchingSeed();

  return buildStorefrontAssistantPageContext({
    path: window.location.pathname,
    route: seed?.page.route,
    canonicalUrl: readCanonicalFromDocument() ?? seed?.page.canonicalUrl,
    title: seed?.page.title || document.title,
    pageKind: seed?.page.kind,
    cart: cartStore.get(),
    surface: readRegisteredSurface() ?? seed?.surface,
  });
}

function freezeSnapshot(
  snapshot: StorefrontAssistantPageContextSnapshot,
): StorefrontAssistantPageContextSnapshot {
  snapshot.cart.lines.forEach((line) => {
    if (line.options) Object.freeze(line.options);
    Object.freeze(line);
  });
  Object.freeze(snapshot.page);
  if (snapshot.surface) {
    if ("selectedOptions" in snapshot.surface) {
      snapshot.surface.selectedOptions.forEach(Object.freeze);
      Object.freeze(snapshot.surface.selectedOptions);
    }
    if ("visibleProductIds" in snapshot.surface) {
      snapshot.surface.visibleFilters.forEach(Object.freeze);
      Object.freeze(snapshot.surface.visibleFilters);
      Object.freeze(snapshot.surface.visibleProductIds);
    }
    if ("exactLineKeys" in snapshot.surface) {
      Object.freeze(snapshot.surface.exactLineKeys);
    }
    Object.freeze(snapshot.surface);
  }
  Object.freeze(snapshot.cart.lines);
  Object.freeze(snapshot.cart);
  return Object.freeze(snapshot);
}

/**
 * Registers buyer-visible state owned by the rendering/controller layer. The
 * bridge never scrapes DOM controls to infer this state.
 */
export function registerStorefrontAssistantSurface(
  initialSurface: StorefrontAssistantSurfaceContext,
): StorefrontAssistantSurfaceRegistration | null {
  if (typeof window === "undefined") return null;

  const path = buildStorefrontAssistantPageContext({
    path: window.location.pathname,
  }).page.path;
  const expectedKind = inferStorefrontAssistantPageKind(path);
  const token = Symbol("storefront-assistant-surface");
  let active = true;
  const normalizedInitial = normalizeStorefrontAssistantSurfaceContext(
    initialSurface,
    expectedKind,
  );
  if (!normalizedInitial) return null;
  registeredSurface = { token, path, surface: normalizedInitial };
  schedulePublish();

  const update = (surface: StorefrontAssistantSurfaceContext): boolean => {
    if (!active) return false;
    if (registeredSurface && registeredSurface.token !== token) return false;
    const normalized = normalizeStorefrontAssistantSurfaceContext(
      surface,
      expectedKind,
    );
    if (!normalized) return false;
    registeredSurface = { token, path, surface: normalized };
    schedulePublish();
    return true;
  };

  return Object.freeze({
    update,
    unregister: () => {
      active = false;
      if (registeredSurface?.token !== token) return;
      registeredSurface = null;
      schedulePublish();
    },
  });
}

export function publishStorefrontAssistantPageContext(
  snapshot: StorefrontAssistantPageContextSnapshot,
): StorefrontAssistantPageContextSnapshot | null {
  if (typeof window === "undefined") return null;

  const frozen = freezeSnapshot(snapshot);
  window[STOREFRONT_ASSISTANT_PAGE_CONTEXT_GLOBAL] = frozen;
  window.dispatchEvent(
    new CustomEvent(STOREFRONT_ASSISTANT_PAGE_CONTEXT_EVENT, {
      detail: frozen,
    }),
  );
  return frozen;
}

function readCurrentPublishedSnapshot(): StorefrontAssistantPageContextSnapshot | null {
  if (typeof window === "undefined") return null;

  const snapshot = window[STOREFRONT_ASSISTANT_PAGE_CONTEXT_GLOBAL];
  if (!snapshot || !Object.isFrozen(snapshot)) return null;

  const current = buildStorefrontAssistantPageContext({
    path: window.location.pathname,
  });
  return snapshot.page.path === current.page.path ? snapshot : null;
}

function publishCurrentSnapshot(): StorefrontAssistantPageContextSnapshot | null {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return null;
  }

  return publishStorefrontAssistantPageContext(readBrowserSnapshot());
}

function getStorefrontAssistantContext(): StorefrontAssistantPageContextSnapshot | null {
  return readCurrentPublishedSnapshot() ?? publishCurrentSnapshot();
}

function schedulePublish(): void {
  if (publishQueued) return;
  publishQueued = true;
  queueMicrotask(() => {
    publishQueued = false;
    publishCurrentSnapshot();
  });
}

function getTargetText(target: unknown): string | null {
  if (typeof target === "string") return target;
  if (target instanceof URL) return target.href;
  return null;
}

function decodePathSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function isSafePathSegment(segment: string): boolean {
  if (
    !segment ||
    segment.length > MAX_ASSISTANT_NAVIGATION_PATH_SEGMENT_LENGTH ||
    !SAFE_PATH_SEGMENT_PATTERN.test(segment)
  ) {
    return false;
  }

  const decoded = decodePathSegment(segment);
  if (!decoded || decoded !== segment) return false;
  if (decoded === "." || decoded === "..") return false;
  return !hasControlCharacter(decoded);
}

function getPathSegments(pathname: string): string[] | null {
  if (
    !pathname.startsWith("/") ||
    pathname.includes("\\") ||
    ENCODED_UNSAFE_PATH_PATTERN.test(pathname)
  ) {
    return null;
  }

  const segments = pathname.split("/").slice(1);
  if (segments.length === 0 || segments.some((segment) => !segment)) {
    return null;
  }

  return segments.every(isSafePathSegment) ? segments : null;
}

function hasBlockedBuyerPathSegment(segments: string[]): boolean {
  return segments.some((segment) =>
    BLOCKED_BUYER_PATH_SEGMENTS.has(segment.toLowerCase()),
  );
}

function isSafeCatalogPath(pathname: string, prefix: string): boolean {
  const prefixPath = `/${prefix}/`;
  if (!pathname.startsWith(prefixPath)) return false;

  const segments = getPathSegments(pathname);
  if (!segments || segments[0] !== prefix) return false;

  const rest = segments.slice(1);
  return rest.length > 0 && !hasBlockedBuyerPathSegment(rest);
}

function isSafeCmsPagePath(pathname: string): boolean {
  const segments = getPathSegments(pathname);
  if (!segments || segments.length !== 1) return false;

  const slug = segments[0].toLowerCase();
  return !RESERVED_CMS_PAGE_SLUGS.has(slug);
}

function hasSensitiveQueryValue(value: string): boolean {
  return (
    TOKEN_LIKE_QUERY_VALUE_PATTERN.test(value) ||
    EMAIL_QUERY_VALUE_PATTERN.test(value) ||
    BANGLADESH_PHONE_QUERY_VALUE_PATTERN.test(value) ||
    BROAD_PHONE_QUERY_VALUE_PATTERN.test(value)
  );
}

function hasSensitiveQueryName(name: string): boolean {
  const normalized = name.toLowerCase();
  return (
    SENSITIVE_QUERY_NAMES.has(normalized) ||
    SENSITIVE_QUERY_NAME_PATTERN.test(normalized)
  );
}

function isSafeSearchQuery(search: string, params: URLSearchParams): boolean {
  if (search.length > MAX_ASSISTANT_NAVIGATION_QUERY_LENGTH) return false;

  const entries = Array.from(params.entries());
  if (entries.length > MAX_ASSISTANT_NAVIGATION_QUERY_PAIRS) return false;

  return entries.every(([key, value]) => {
    if (
      !key ||
      key.length > MAX_ASSISTANT_NAVIGATION_QUERY_KEY_LENGTH ||
      value.length > MAX_ASSISTANT_NAVIGATION_QUERY_VALUE_LENGTH ||
      hasControlCharacter(key) ||
      hasControlCharacter(value) ||
      !SAFE_QUERY_KEY_PATTERN.test(key) ||
      hasSensitiveQueryName(key) ||
      hasSensitiveQueryValue(value)
    ) {
      return false;
    }

    return true;
  });
}

function isAllowedBuyerNavigationUrl(url: URL): boolean {
  if (url.hash || url.username || url.password) return false;

  const pathname = url.pathname;
  if (pathname === "/") return url.search === "";
  if (pathname === "/cart") return url.search === "";
  if (pathname === "/search") {
    return isSafeSearchQuery(url.search, url.searchParams);
  }

  if (url.search) return false;

  return (
    isSafeCatalogPath(pathname, "products") ||
    isSafeCatalogPath(pathname, "categories") ||
    isSafeCatalogPath(pathname, "collections") ||
    isSafeCmsPagePath(pathname)
  );
}

export function resolveStorefrontAssistantNavigationTarget(
  target: unknown,
  origin: string,
): string | null {
  const text = getTargetText(target);
  if (!text) return null;

  if (
    text !== text.trim() ||
    text.length > MAX_ASSISTANT_NAVIGATION_TARGET_LENGTH ||
    hasControlCharacter(text) ||
    text.startsWith("//") ||
    text.includes("\\") ||
    RAW_PATH_TRAVERSAL_PATTERN.test(text) ||
    ENCODED_UNSAFE_PATH_PATTERN.test(text)
  ) {
    return null;
  }

  const isAbsoluteHttpUrl = /^https?:\/\//i.test(text);
  if (!text.startsWith("/") && !isAbsoluteHttpUrl) return null;

  let url: URL;
  try {
    url = new URL(text, origin);
  } catch {
    return null;
  }

  if (
    url.origin !== origin ||
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    !isAllowedBuyerNavigationUrl(url)
  ) {
    return null;
  }

  return `${url.pathname}${url.search}`;
}

function navigateStorefrontAssistant(target: unknown): boolean {
  if (typeof window === "undefined") return false;

  const targetPath = resolveStorefrontAssistantNavigationTarget(
    target,
    window.location.origin,
  );
  if (!targetPath) return false;

  const currentPath = `${window.location.pathname}${window.location.search}`;
  if (targetPath === currentPath) {
    publishCurrentSnapshot();
    return true;
  }

  window.location.assign(targetPath);
  return true;
}

function installStorefrontAssistantBridgeGlobal(): void {
  if (typeof window === "undefined") return;

  window[STOREFRONT_ASSISTANT_BRIDGE_GLOBAL] = Object.freeze({
    getContext: getStorefrontAssistantContext,
    navigate: navigateStorefrontAssistant,
  });
}

export function installStorefrontAssistantPageContextBridge(): StorefrontAssistantPageContextSnapshot | null {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return null;
  }

  installStorefrontAssistantBridgeGlobal();

  if (!installed) {
    installed = true;
    cartStore.subscribe(schedulePublish);
    document.addEventListener("cart-updated", schedulePublish);
    document.addEventListener("astro:page-load", schedulePublish);
    window.addEventListener("popstate", schedulePublish);
    window.addEventListener("hashchange", schedulePublish);
  }

  return publishCurrentSnapshot();
}
