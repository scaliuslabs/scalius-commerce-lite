import { useEffect, useRef } from "react";
import { useRouter } from "@tanstack/react-router";

const ADMIN_SCROLL_STORAGE_PREFIX = "scalius-admin-scroll-v1:";
const DEFAULT_ADMIN_SCROLL_ELEMENT_ID = "admin-main-scroll";

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
    // Storage can be unavailable in locked-down browser contexts; scroll reset still works.
  }
}

function getAdminScrollElement(elementId: string) {
  return document.getElementById(elementId);
}

export function useAdminNestedScrollRestoration(
  elementId = DEFAULT_ADMIN_SCROLL_ELEMENT_ID,
) {
  const router = useRouter();
  const nextNavigationIsPopRef = useRef(false);
  const restoreFrameRef = useRef<number | null>(null);

  useEffect(() => {
    const handlePopState = () => {
      nextNavigationIsPopRef.current = true;
    };

    window.addEventListener("popstate", handlePopState);

    const unsubscribeBeforeLoad = router.subscribe("onBeforeLoad", (event) => {
      if (!event.fromLocation) return;

      const scrollElement = getAdminScrollElement(elementId);
      if (!scrollElement) return;

      writeScrollTop(event.fromLocation.href, scrollElement.scrollTop);
    });

    const unsubscribeRendered = router.subscribe("onRendered", (event) => {
      if (restoreFrameRef.current !== null) {
        window.cancelAnimationFrame(restoreFrameRef.current);
      }

      restoreFrameRef.current = window.requestAnimationFrame(() => {
        restoreFrameRef.current = null;

        const scrollElement = getAdminScrollElement(elementId);
        if (!scrollElement) {
          nextNavigationIsPopRef.current = false;
          return;
        }

        if (nextNavigationIsPopRef.current) {
          scrollElement.scrollTop = readScrollTop(event.toLocation.href);
        } else {
          scrollElement.scrollTop = 0;
        }

        nextNavigationIsPopRef.current = false;
      });
    });

    return () => {
      window.removeEventListener("popstate", handlePopState);
      unsubscribeBeforeLoad();
      unsubscribeRendered();

      if (restoreFrameRef.current !== null) {
        window.cancelAnimationFrame(restoreFrameRef.current);
      }
    };
  }, [elementId, router]);
}
