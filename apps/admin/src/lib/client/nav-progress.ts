// src/lib/client/nav-progress.ts
// Navigation progress tracking: click interception, loading state, view transitions

import { navigateTo } from "@/lib/client/navigate";

type AdminNavWindow = Window & {
  __adminNavProgressBound__?: boolean;
  __adminPendingDestination__?: string | null;
};

export function initNavProgress(): void {
  const navWindow = window as AdminNavWindow;

  if (navWindow.__adminNavProgressBound__) return;
  navWindow.__adminNavProgressBound__ = true;

  const root = document.documentElement;
  let resetTimer: number | undefined;
  let navStartAt = 0;
  const MIN_LOADER_VISIBLE_MS = 150;

  const clearPendingState = () => {
    navWindow.__adminPendingDestination__ = null;
    root.classList.remove("admin-nav-pending");
  };

  const startLoading = () => {
    if (resetTimer) window.clearTimeout(resetTimer);
    navStartAt = Date.now();
    root.classList.remove("admin-nav-loaded");
    root.classList.add("admin-nav-pending");
    root.classList.add("admin-nav-loading");
  };

  const stopLoading = () => {
    const finalize = () => {
      clearPendingState();
      if (!root.classList.contains("admin-nav-loading")) return;
      root.classList.add("admin-nav-loaded");
      resetTimer = window.setTimeout(() => {
        root.classList.remove(
          "admin-nav-loading",
          "admin-nav-loaded",
          "admin-nav-pending",
        );
      }, 450);
    };

    const elapsed = navStartAt ? Date.now() - navStartAt : MIN_LOADER_VISIBLE_MS;
    const remaining = Math.max(0, MIN_LOADER_VISIBLE_MS - elapsed);
    if (remaining > 0) {
      window.setTimeout(finalize, remaining);
      return;
    }
    finalize();
  };

  const getInternalAdminDestination = (
    anchor: HTMLAnchorElement,
  ): string | null => {
    const href = anchor.getAttribute("href");
    if (!href || href.startsWith("#")) return null;
    if (anchor.target && anchor.target !== "_self") return null;
    if (
      anchor.hasAttribute("download") ||
      anchor.hasAttribute("data-astro-reload")
    )
      return null;

    const destination = new URL(anchor.href, window.location.href);
    if (destination.origin !== window.location.origin) return null;
    if (!destination.pathname.startsWith("/admin")) return null;

    const isSamePathAndSearch =
      destination.pathname === window.location.pathname &&
      destination.search === window.location.search;

    if (isSamePathAndSearch && destination.hash) return null;
    if (destination.href === window.location.href) return null;

    return destination.href;
  };

  const handleInternalAdminLinkClick = (event: MouseEvent) => {
    if (event.defaultPrevented) return;
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;

    const target = event.target as Element | null;
    const anchor = target?.closest("a[href]") as HTMLAnchorElement | null;
    if (!anchor) return;

    const destination = getInternalAdminDestination(anchor);
    if (!destination) return;

    if (navWindow.__adminPendingDestination__ === destination) {
      event.preventDefault();
      return;
    }

    navWindow.__adminPendingDestination__ = destination;
    root.classList.remove("admin-nav-loaded");
    root.classList.add("admin-nav-pending");
    event.preventDefault();
    void navigateTo(destination);
  };

  document.addEventListener("astro:before-preparation", startLoading);
  document.addEventListener("astro:after-swap", stopLoading);
  document.addEventListener("astro:page-load", stopLoading);
  document.addEventListener("click", handleInternalAdminLinkClick);
}
