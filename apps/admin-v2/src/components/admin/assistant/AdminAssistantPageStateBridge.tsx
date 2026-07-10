import { useEffect } from "react";

import {
  clearAdminAssistantPageState,
  createAdminAssistantPageStateSnapshot,
  publishAdminAssistantPageState,
  subscribeAdminAssistantSurfaceRegistry,
} from "./page-state";

const DEFAULT_ADMIN_SCROLL_ELEMENT_ID = "admin-main-scroll";
const PAGE_HEADING_SELECTOR =
  "[data-assistant-page-heading], h1, [role='heading'][aria-level='1']";
const ROUTE_SETTLE_DELAYS_MS = [80, 250, 750] as const;

interface AdminAssistantPageStateBridgeProps {
  routePath: string;
  scrollElementId?: string;
  enabled?: boolean;
}

export function AdminAssistantPageStateBridge({
  routePath,
  scrollElementId = DEFAULT_ADMIN_SCROLL_ELEMENT_ID,
  enabled = true,
}: AdminAssistantPageStateBridgeProps) {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!enabled) {
      clearAdminAssistantPageState();
      return;
    }

    const scrollElement = document.getElementById(scrollElementId);
    let animationFrame: number | null = null;
    const settleTimers: number[] = [];

    const publish = () => {
      animationFrame = null;
      publishAdminAssistantPageState(
        createAdminAssistantPageStateSnapshot({
          routePath,
          pageTitle: document.title,
          pageHeading: readPageHeading(scrollElement),
          scrollElement,
        }),
      );
    };

    const schedulePublish = () => {
      if (animationFrame !== null) return;
      animationFrame = window.requestAnimationFrame(publish);
    };

    const unsubscribeRegistry = subscribeAdminAssistantSurfaceRegistry(schedulePublish);
    const observer = createObserver(schedulePublish);

    scrollElement?.addEventListener("scroll", schedulePublish, { passive: true });
    window.addEventListener("resize", schedulePublish);
    observer?.observe(document.head, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    schedulePublish();
    for (const delay of ROUTE_SETTLE_DELAYS_MS) {
      settleTimers.push(window.setTimeout(schedulePublish, delay));
    }

    return () => {
      unsubscribeRegistry();
      observer?.disconnect();
      scrollElement?.removeEventListener("scroll", schedulePublish);
      window.removeEventListener("resize", schedulePublish);
      for (const timer of settleTimers) {
        window.clearTimeout(timer);
      }
      if (animationFrame !== null) {
        window.cancelAnimationFrame(animationFrame);
      }
    };
  }, [enabled, routePath, scrollElementId]);

  useEffect(() => clearAdminAssistantPageState, []);

  return null;
}

function readPageHeading(scrollElement: HTMLElement | null): string | null {
  const heading = scrollElement?.querySelector<HTMLElement>(PAGE_HEADING_SELECTOR);
  return heading?.textContent ?? null;
}

function createObserver(callback: () => void): MutationObserver | null {
  if (typeof MutationObserver === "undefined") return null;
  return new MutationObserver(callback);
}
