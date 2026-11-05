import type { AddToCartEventDetail, OpenCartEventDetail } from "@/components/CartFlyout";
import type { AuthModalOpenDetail } from "@/components/AuthModal";
import { installRailFocus } from "@/scripts/rail-focus";
import { loadLazyScript, type LazyScriptOptions } from "@/scripts/lazy-script";
import { pagePath } from "@/lib/presence-url";

function hasCustomerAuthMirrorCookie(): boolean {
  return document.cookie
    .split(";")
    .some((cookie) => cookie.trim() === "cs_auth=1");
}

/**
 * The three parts every page loads on first use (sign-in, search and the
 * cart flyout), and the cart itself, which adds a queued line when the
 * flyout cannot load.
 */
export interface LazyGlobalUiLoaders {
  auth: () => Promise<{ mountAuthModal: () => unknown }>;
  search: () => Promise<{ mountCommandPalette: () => unknown }>;
  cart: () => Promise<{ mountCartFlyout: () => unknown }>;
  cartStore: () => Promise<{ addToCart: (line: AddToCartEventDetail) => Promise<boolean> }>;
}

const LOADERS: LazyGlobalUiLoaders = {
  auth: () => import("@/components/client/mount-auth-modal"),
  search: () => import("@/components/client/mount-command-palette"),
  cart: () => import("@/components/client/mount-cart-flyout"),
  cartStore: () => import("@/store/cart"),
};

/**
 * Sign-in, search and the cart flyout load the first time a buyer reaches
 * for them. Each loads through `loadLazyScript`: a failed download is tried
 * once more, or the page reloads when the store serves a newer build and
 * nothing typed would be lost. When it still fails, the attempt is
 * forgotten (its pending open dropped), so the next reach tries again: the
 * part is never dead for the rest of the visit. A queued add is never
 * dropped: the flyout performs it once it loads, and when the flyout cannot
 * load the cart adds it without the flyout (it stays queued if the cart
 * cannot load either, for the next attempt).
 */
export function installLazyGlobalUi(loaders: LazyGlobalUiLoaders = LOADERS, options: LazyScriptOptions = {}): void {
  if (window.__scaliusLazyGlobalUiInstalled) return;
  window.__scaliusLazyGlobalUiInstalled = true;
  installRailFocus();

  let authLoading: Promise<unknown> | null = null;
  const loadAuth = (openModal: boolean, detail?: AuthModalOpenDetail) => {
    if (openModal) {
      window.__scaliusAuthModalOpenPending = true;
      if (detail) window.__scaliusAuthModalDetailPending = detail;
    }
    authLoading ??= loadLazyScript(loaders.auth, options).then(
      ({ mountAuthModal }) => mountAuthModal(),
      () => {
        authLoading = null;
        delete window.__scaliusAuthModalOpenPending;
        delete window.__scaliusAuthModalDetailPending;
      },
    );
    return authLoading;
  };
  window.addEventListener("open-auth-modal", (event) => {
    void loadAuth(true, (event as CustomEvent<AuthModalOpenDetail | undefined>).detail);
  });

  if (hasCustomerAuthMirrorCookie()) {
    const resumeAuth = () => void loadAuth(false);
    if ("requestIdleCallback" in window) {
      window.requestIdleCallback(resumeAuth, { timeout: 2500 });
    } else {
      window.setTimeout(resumeAuth, 1);
    }
  }

  let searchLoading: Promise<unknown> | null = null;
  let searchReady = false;
  const loadSearch = () => {
    window.__scaliusSearchPaletteOpenPending = true;
    searchLoading ??= loadLazyScript(loaders.search, options).then(
      ({ mountCommandPalette }) => {
        mountCommandPalette();
        searchReady = true;
      },
      () => {
        searchLoading = null;
        delete window.__scaliusSearchPaletteOpenPending;
      },
    );
  };
  document.addEventListener("open-search-palette", () => {
    if (!searchReady) loadSearch();
  });
  document.addEventListener("keydown", (event) => {
    if (!searchReady && (event.metaKey || event.ctrlKey) && event.key === "k") {
      event.preventDefault();
      loadSearch();
    }
  });

  let cartLoading: Promise<void> | null = null;
  let cartReady = false;
  const loadCart = () => {
    cartLoading ??= loadLazyScript(loaders.cart, options).then(
      async ({ mountCartFlyout }) => {
        await mountCartFlyout();
        cartReady = true;
      },
      () => {
        // The flyout opens on the next reach; its queued adds are made now, without it.
        cartLoading = null;
        void addQueuedLines();
      },
    );
  };
  const addQueuedLines = async () => {
    const queued = window.__scaliusCartPendingEvents ?? [];
    // An open needs the flyout; an add never waits for it.
    window.__scaliusCartPendingEvents = queued.filter((pending) => pending.type === "add");
    if (window.__scaliusCartPendingEvents.length === 0) return;
    let store: Awaited<ReturnType<LazyGlobalUiLoaders["cartStore"]>>;
    try {
      store = await loadLazyScript(loaders.cartStore, options);
    } catch {
      return; // Still queued: the next attempt adds them.
    }
    const adds = (window.__scaliusCartPendingEvents ?? []).splice(0);
    for (const pending of adds) {
      if (pending.type !== "add") continue;
      if (await store.addToCart(pending.detail).catch(() => false) && pending.detail.redirectToCart) {
        window.location.href = pagePath("/cart");
      }
    }
  };
  const queueCartEvent = (
    event: Event,
    pending:
      | { type: "open"; detail?: OpenCartEventDetail }
      | { type: "add"; detail: AddToCartEventDetail },
  ) => {
    if (cartReady) return;
    event.stopImmediatePropagation();
    (window.__scaliusCartPendingEvents ??= []).push(pending);
    loadCart();
  };
  // Start loading the drawer when a buyer reaches for an add button, so it is
  // ready the moment the line is in and opens without a visible gap.
  const warmCart = (event: Event) => {
    if (cartReady || cartLoading) return;
    const target = event.target;
    if (target instanceof Element && target.closest('[data-action="add-to-cart"], a[data-card-quick-add]')) loadCart();
  };
  document.addEventListener("pointerover", warmCart, { passive: true });
  document.addEventListener("pointerdown", warmCart, { passive: true });
  document.addEventListener("focusin", warmCart, { passive: true });
  document.addEventListener("open-cart", (event) => {
    queueCartEvent(event, {
      type: "open",
      detail: (event as CustomEvent<OpenCartEventDetail | undefined>).detail,
    });
  });
  document.addEventListener("add-to-cart", (event) => {
    const detail = (event as CustomEvent<AddToCartEventDetail>).detail;
    if (detail) queueCartEvent(event, { type: "add", detail });
  });
}
