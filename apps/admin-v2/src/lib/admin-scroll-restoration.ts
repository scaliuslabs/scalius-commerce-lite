import { useEffect, useLayoutEffect, useRef } from "react";
import { useLocation, useRouter } from "@tanstack/react-router";

const ADMIN_SCROLL_STORAGE_PREFIX = "scalius-admin-scroll-v2:";
const DEFAULT_ADMIN_SCROLL_ELEMENT_ID = "admin-main-scroll";
const MAX_RESTORE_FRAMES = 30;
const WORKSPACE_VIEW_SEARCH_PARAMS = ["section", "panel", "kind"] as const;

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

type LockedScrollContent = {
  element: HTMLElement;
  previousMinHeight: string;
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

function getAdminScrollContent(scrollElement: HTMLElement) {
  return scrollElement.querySelector<HTMLElement>(
    ":scope > [data-admin-scroll-content]",
  );
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

    return WORKSPACE_VIEW_SEARCH_PARAMS.some(
      (key) => from.searchParams.get(key) !== to.searchParams.get(key),
    );
  } catch {
    return false;
  }
}

export function useAdminNestedScrollRestoration(
  elementId = DEFAULT_ADMIN_SCROLL_ELEMENT_ID,
) {
  const router = useRouter();
  const currentHref = useLocation({ select: (location) => location.href });
  const nextNavigationIsPopRef = useRef(false);
  const pendingRestoreHrefRef = useRef<string | null>(null);
  const restoreFrameRef = useRef<number | null>(null);
  const lockedContentRef = useRef<LockedScrollContent | null>(null);
  const restoreStoredScrollRef = useRef<(href: string) => void>(() => undefined);

  useLayoutEffect(() => {
    if (pendingRestoreHrefRef.current !== currentHref) return;

    // The admin layout observes the committed location in the same React
    // render as the destination panel. Restore in a layout effect so no frame
    // of that panel can paint at the nested scroller's clamped position.
    restoreStoredScrollRef.current(currentHref);
    pendingRestoreHrefRef.current = null;
  }, [currentHref]);

  useEffect(() => {
    const cancelRestore = () => {
      if (restoreFrameRef.current !== null) {
        window.cancelAnimationFrame(restoreFrameRef.current);
        restoreFrameRef.current = null;
      }
    };

    const unlockScrollRange = () => {
      const lock = lockedContentRef.current;
      if (!lock) return;

      lock.element.style.minHeight = lock.previousMinHeight;
      lockedContentRef.current = null;
    };

    const lockScrollRange = (
      scrollElement: HTMLElement,
      minimumScrollHeight = scrollElement.scrollHeight,
    ) => {
      unlockScrollRange();

      const contentElement = getAdminScrollContent(scrollElement);
      if (!contentElement) return;

      lockedContentRef.current = {
        element: contentElement,
        previousMinHeight: contentElement.style.minHeight,
      };
      contentElement.style.minHeight = `${Math.max(
        contentElement.scrollHeight,
        minimumScrollHeight,
      )}px`;
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
        unlockScrollRange();
        const maxTop = Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight);

        if (targetTop <= maxTop || frame >= MAX_RESTORE_FRAMES) {
          scrollElement.scrollTop = Math.min(targetTop, maxTop);
          nextNavigationIsPopRef.current = false;
          return;
        }

        // Keep the nested scroll range tall enough to retain the destination
        // position while a lazy panel finishes mounting. The lock is removed
        // and remeasured at the start of every frame, before paint.
        lockScrollRange(
          scrollElement,
          targetTop + scrollElement.clientHeight,
        );
        scrollElement.scrollTop = targetTop;
        scheduleStoredRestore(href, frame + 1);
      });
    };

    const restoreStoredScroll = (href: string) => {
      cancelRestore();

      const scrollElement = getAdminScrollElement(elementId);
      if (!scrollElement) {
        nextNavigationIsPopRef.current = false;
        return;
      }

      const targetTop = readScrollTop(href);
      unlockScrollRange();
      const maxTop = Math.max(
        0,
        scrollElement.scrollHeight - scrollElement.clientHeight,
      );
      scrollElement.scrollTop = Math.min(targetTop, maxTop);

      if (targetTop > maxTop) {
        lockScrollRange(
          scrollElement,
          targetTop + scrollElement.clientHeight,
        );
        scrollElement.scrollTop = targetTop;
        scheduleStoredRestore(href);
        return;
      }

      nextNavigationIsPopRef.current = false;
    };

    restoreStoredScrollRef.current = restoreStoredScroll;

    window.addEventListener("popstate", handlePopState);
    const navigationTarget = getNavigationEventTarget();
    navigationTarget?.addEventListener("navigate", handleNavigate);

    const unsubscribeBeforeLoad = router.subscribe("onBeforeLoad", (event) => {
      if (!event.fromLocation) return;

      const scrollElement = getAdminScrollElement(elementId);
      if (!scrollElement) return;

      writeScrollTop(event.fromLocation.href, scrollElement.scrollTop);

      const switchedWorkspaceView = workspaceViewChanged(
        event.fromLocation.href,
        event.toLocation.href,
      );
      if (nextNavigationIsPopRef.current || switchedWorkspaceView) {
        // A newly selected panel may be shorter for a render. Preserve the
        // outgoing range until the destination position is restored so the
        // browser cannot visibly clamp the nested scroller to zero.
        const targetTop = readScrollTop(event.toLocation.href);
        pendingRestoreHrefRef.current = event.toLocation.href;
        lockScrollRange(
          scrollElement,
          Math.max(
            scrollElement.scrollHeight,
            targetTop + scrollElement.clientHeight,
          ),
        );
      }
    });

    const unsubscribeRendered = router.subscribe("onRendered", (event) => {
      if (
        !nextNavigationIsPopRef.current &&
        pendingRestoreHrefRef.current !== event.toLocation.href
      ) return;

      // Fallback for a traversal that does not produce an observing layout
      // render in the admin shell. Normal workspace changes restore from the
      // location-keyed layout effect above. A previously visited tab returns
      // to its own position; a first visit reads as zero. Delayed panels keep
      // retrying until their height exists.
      restoreStoredScroll(event.toLocation.href);
      pendingRestoreHrefRef.current = null;
    });

    return () => {
      window.removeEventListener("popstate", handlePopState);
      navigationTarget?.removeEventListener("navigate", handleNavigate);
      unsubscribeBeforeLoad();
      unsubscribeRendered();
      cancelRestore();
      unlockScrollRange();
      pendingRestoreHrefRef.current = null;
      restoreStoredScrollRef.current = () => undefined;
    };
  }, [elementId, router]);
}
