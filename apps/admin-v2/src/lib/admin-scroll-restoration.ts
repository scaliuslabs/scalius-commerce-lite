import { useEffect, useRef } from "react";
import { useRouter } from "@tanstack/react-router";

const ADMIN_SCROLL_STORAGE_PREFIX = "scalius-admin-scroll-v2:";
const DEFAULT_ADMIN_SCROLL_ELEMENT_ID = "admin-main-scroll";
const MAX_RESTORE_FRAMES = 30;

type NavigationTraverseEvent = Event & { navigationType?: string };
type NavigationEventTarget = EventTarget & {
  addEventListener(
    type: "navigate",
    listener: (event: NavigationTraverseEvent) => void,
  ): void;
  removeEventListener(
    type: "navigate",
    listener: (event: NavigationTraverseEvent) => void,
  ): void;
};

function storageKey(href: string) {
  return `${ADMIN_SCROLL_STORAGE_PREFIX}${href}`;
}

function readScrollTop(href: string) {
  try {
    const stored = window.sessionStorage.getItem(storageKey(href));
    if (!stored) return 0;

    const parsed = Number.parseFloat(stored);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  } catch {
    return 0;
  }
}

function hasStoredScrollTop(href: string) {
  try {
    return window.sessionStorage.getItem(storageKey(href)) !== null;
  } catch {
    return false;
  }
}

function writeScrollTop(href: string, scrollTop: number) {
  try {
    window.sessionStorage.setItem(storageKey(href), String(Math.max(0, scrollTop)));
  } catch {
    // Storage can be unavailable in locked-down browser contexts.
  }
}

function getAdminScrollElement(elementId: string) {
  return document.getElementById(elementId);
}

function getNavigationEventTarget() {
  const maybeWindow = window as Window & {
    navigation?: NavigationEventTarget;
  };

  return maybeWindow.navigation;
}

function workspaceViewChanged(fromHref: string, toHref: string) {
  try {
    const from = new URL(fromHref, window.location.origin);
    const to = new URL(toHref, window.location.origin);

    if (from.pathname !== to.pathname) return false;

    return from.searchParams.get("section") !== to.searchParams.get("section") ||
      from.searchParams.get("panel") !== to.searchParams.get("panel");
  } catch {
    return false;
  }
}

export function useAdminNestedScrollRestoration(
  elementId = DEFAULT_ADMIN_SCROLL_ELEMENT_ID,
) {
  const router = useRouter();
  const nextNavigationIsPopRef = useRef(false);
  const restoreFrameRef = useRef<number | null>(null);

  useEffect(() => {
    const cancelRestore = () => {
      if (restoreFrameRef.current !== null) {
        window.cancelAnimationFrame(restoreFrameRef.current);
        restoreFrameRef.current = null;
      }
    };

    const handlePopState = () => {
      nextNavigationIsPopRef.current = true;
    };

    const handleNavigate = (event: NavigationTraverseEvent) => {
      if (event.navigationType === "traverse") {
        nextNavigationIsPopRef.current = true;
      }
    };

    const scheduleStoredRestore = (href: string, frame = 0) => {
      cancelRestore();
      restoreFrameRef.current = window.requestAnimationFrame(() => {
        restoreFrameRef.current = null;

        const scrollElement = getAdminScrollElement(elementId);
        if (!scrollElement) {
          nextNavigationIsPopRef.current = false;
          return;
        }

        const targetTop = readScrollTop(href);
        const maxTop = Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight);

        if (targetTop <= maxTop || frame >= MAX_RESTORE_FRAMES) {
          scrollElement.scrollTop = Math.min(targetTop, maxTop);
          nextNavigationIsPopRef.current = false;
          return;
        }

        scheduleStoredRestore(href, frame + 1);
      });
    };

    window.addEventListener("popstate", handlePopState);
    const navigationTarget = getNavigationEventTarget();
    navigationTarget?.addEventListener("navigate", handleNavigate);

    const unsubscribeBeforeLoad = router.subscribe("onBeforeLoad", (event) => {
      if (!event.fromLocation) return;

      const scrollElement = getAdminScrollElement(elementId);
      if (!scrollElement) return;

      writeScrollTop(event.fromLocation.href, scrollElement.scrollTop);

      // A tab/panel is its own workspace view. Position the nested scroller
      // before React swaps panels so a short lazy fallback cannot clamp the
      // previous view's scroll position and produce a visible jump.
      if (workspaceViewChanged(
        event.fromLocation.href,
        event.toLocation.href,
      )) {
        const targetTop = readScrollTop(event.toLocation.href);
        const maxTop = Math.max(
          0,
          scrollElement.scrollHeight - scrollElement.clientHeight,
        );
        scrollElement.scrollTop = Math.min(targetTop, maxTop);
      }
    });

    const unsubscribeRendered = router.subscribe("onRendered", (event) => {
      const switchedWorkspaceView = event.fromLocation
        ? workspaceViewChanged(
            event.fromLocation.href,
            event.toLocation.href,
          )
        : false;
      const revisitingQueryState =
        event.pathChanged === false &&
        event.hrefChanged &&
        hasStoredScrollTop(event.toLocation.href);
      if (
        !nextNavigationIsPopRef.current &&
        !switchedWorkspaceView &&
        !revisitingQueryState
      ) return;

      scheduleStoredRestore(event.toLocation.href);
    });

    return () => {
      window.removeEventListener("popstate", handlePopState);
      navigationTarget?.removeEventListener("navigate", handleNavigate);
      unsubscribeBeforeLoad();
      unsubscribeRendered();
      cancelRestore();
    };
  }, [elementId, router]);
}
