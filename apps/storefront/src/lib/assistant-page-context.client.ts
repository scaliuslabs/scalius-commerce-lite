import { cartStore } from "@/store/cart";

import {
  STOREFRONT_ASSISTANT_PAGE_CONTEXT_EVENT,
  STOREFRONT_ASSISTANT_PAGE_CONTEXT_GLOBAL,
  buildStorefrontAssistantPageContext,
  type StorefrontAssistantPageContextSnapshot,
} from "./assistant-page-context";

declare global {
  interface Window {
    __SCALIUS_STOREFRONT_PAGE_CONTEXT__?: StorefrontAssistantPageContextSnapshot;
  }

  interface WindowEventMap {
    "scalius:storefront-page-context:change": CustomEvent<
      StorefrontAssistantPageContextSnapshot
    >;
  }
}

let installed = false;
let publishQueued = false;

function readCanonicalFromDocument(): string | null {
  if (typeof document === "undefined") return null;
  const canonical = document.querySelector<HTMLLinkElement>(
    'link[rel="canonical"]',
  );
  return canonical?.href || canonical?.getAttribute("href") || null;
}

function readMatchingSeed(): StorefrontAssistantPageContextSnapshot["page"] | null {
  const seed = window.__SCALIUS_STOREFRONT_PAGE_CONTEXT__?.page;
  if (!seed) return null;

  const current = buildStorefrontAssistantPageContext({
    path: window.location.pathname,
  });
  return seed.path === current.page.path ? seed : null;
}

function readBrowserSnapshot(): StorefrontAssistantPageContextSnapshot {
  const seed = readMatchingSeed();

  return buildStorefrontAssistantPageContext({
    path: window.location.pathname,
    route: seed?.route,
    canonicalUrl: readCanonicalFromDocument() ?? seed?.canonicalUrl,
    title: document.title || seed?.title,
    pageKind: seed?.kind,
    cart: cartStore.get(),
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
  Object.freeze(snapshot.cart.lines);
  Object.freeze(snapshot.cart);
  return Object.freeze(snapshot);
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

function publishCurrentSnapshot(): StorefrontAssistantPageContextSnapshot | null {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return null;
  }

  return publishStorefrontAssistantPageContext(readBrowserSnapshot());
}

function schedulePublish(): void {
  if (publishQueued) return;
  publishQueued = true;
  queueMicrotask(() => {
    publishQueued = false;
    publishCurrentSnapshot();
  });
}

export function installStorefrontAssistantPageContextBridge(): StorefrontAssistantPageContextSnapshot | null {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return null;
  }

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
