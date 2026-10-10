import { useEffect } from "react";

/**
 * Floating overlays (popovers, menus, selects, tooltips) keep clear of the
 * 56px dashboard top bar plus an 8px gap, and 12px from the other edges. Radix
 * uses this both to flip sides and to compute the `--radix-*-available-height`
 * that caps each panel, so a panel never covers the top bar or runs off screen.
 */
export const OVERLAY_COLLISION_PADDING = { top: 64, right: 12, bottom: 12, left: 12 };

// Radix hides modal backgrounds from screen readers. Also remove their tab
// stops, preserving existing inert state across nested or overlapping portals.
let scopes = 0;
let observer: MutationObserver | undefined;
const backgrounds = new Map<HTMLElement, boolean>();

function syncModalBackground() {
  for (const [node, wasInert] of backgrounds) {
    if (!node.isConnected || !node.hasAttribute("data-aria-hidden")) {
      node.inert = wasInert;
      backgrounds.delete(node);
    }
  }
  for (const node of document.querySelectorAll<HTMLElement>('[data-aria-hidden="true"]')) {
    if (!backgrounds.has(node)) backgrounds.set(node, node.inert);
    node.inert = true;
  }
}

/** Mount inside a Radix modal's content so it lives only while the portal does. */
export function ModalInertBackground() {
  useEffect(() => {
    if (scopes++ === 0) {
      observer = new MutationObserver(syncModalBackground);
      observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["data-aria-hidden"] });
    }
    syncModalBackground();
    return () => {
      if (--scopes !== 0) return;
      observer?.disconnect();
      observer = undefined;
      for (const [node, wasInert] of backgrounds) node.inert = wasInert;
      backgrounds.clear();
    };
  }, []);
  return null;
}
