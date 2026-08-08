/**
 * Builds the small, request-aware bootstrap that runs before Astro's deferred
 * prefetch module. Public anonymous pages keep Astro's normal prefetch policy;
 * any request that bypasses the public cache suppresses speculative navigation
 * work for the rest of the document lifetime.
 */
export function buildPrivateSessionPrefetchGuardScript(
  initiallySuppressed: boolean,
): string {
  return `(() => {
  const prefetchAttribute = "data-astro-prefetch";
  const ownerAttribute = "data-storefront-session-prefetch";
  const ownedAnchors = new WeakSet();
  let active = false;
  let observer = null;

  const markAnchor = (anchor) => {
    if (anchor.getAttribute(prefetchAttribute) === "false" || ownedAnchors.has(anchor)) return;
    ownedAnchors.add(anchor);
    anchor.setAttribute(prefetchAttribute, "false");
    anchor.setAttribute(ownerAttribute, "");
  };

  const markTree = (root) => {
    if (root instanceof HTMLAnchorElement) markAnchor(root);
    if (typeof root.querySelectorAll === "function") {
      root.querySelectorAll("a").forEach(markAnchor);
    }
  };

  const activate = () => {
    if (active) return;
    active = true;
    markTree(document);
    observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node instanceof Element) markTree(node);
        }
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  };

  document.addEventListener("mouseenter", (event) => {
    if (!active || !(event.target instanceof Element)) return;
    const anchor = event.target.closest("a");
    if (anchor && ownedAnchors.has(anchor)) event.stopImmediatePropagation();
  }, true);
  window.addEventListener("customer-login", activate);
  window.addEventListener("storefront-cookie-created", activate);
  if (${initiallySuppressed}) activate();
})();`;
}
