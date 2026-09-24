import type { AddToCartEventDetail } from "@/components/CartFlyout";
import type { AuthModalPrefill } from "@/components/AuthModal";

function hasCustomerAuthMirrorCookie(): boolean {
  return document.cookie
    .split(";")
    .some((cookie) => cookie.trim().startsWith("cs_auth=1"));
}

export function installLazyGlobalUi(): void {
  if (window.__scaliusLazyGlobalUiInstalled) return;
  window.__scaliusLazyGlobalUiInstalled = true;

  let authLoading: Promise<unknown> | null = null;
  const loadAuth = (openModal: boolean, prefill?: AuthModalPrefill) => {
    if (openModal) {
      window.__scaliusAuthModalOpenPending = true;
      if (prefill) window.__scaliusAuthModalPrefillPending = prefill;
    }
    authLoading ??= import("@/components/client/mount-auth-modal").then(
      ({ mountAuthModal }) => mountAuthModal(),
    );
    return authLoading;
  };
  window.addEventListener("open-auth-modal", (event) => {
    const prefill = (event as CustomEvent<{ prefill?: AuthModalPrefill }>).detail?.prefill;
    void loadAuth(true, prefill);
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
    searchLoading ??= import("@/components/client/mount-command-palette").then(
      ({ mountCommandPalette }) => {
        mountCommandPalette();
        searchReady = true;
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
  const queueCartEvent = (
    event: Event,
    pending:
      | { type: "open" }
      | { type: "add"; detail: AddToCartEventDetail },
  ) => {
    if (cartReady) return;
    event.stopImmediatePropagation();
    (window.__scaliusCartPendingEvents ??= []).push(pending);
    cartLoading ??= import("@/components/client/mount-cart-flyout")
      .then(({ mountCartFlyout }) => mountCartFlyout())
      .then(() => {
        cartReady = true;
      });
  };
  document.addEventListener("open-cart", (event) => {
    queueCartEvent(event, { type: "open" });
  });
  document.addEventListener("add-to-cart", (event) => {
    const detail = (event as CustomEvent<AddToCartEventDetail>).detail;
    if (detail) queueCartEvent(event, { type: "add", detail });
  });
}
