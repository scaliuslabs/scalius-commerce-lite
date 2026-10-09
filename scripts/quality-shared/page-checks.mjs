// Browser-side pieces shared by the storefront and dashboard quality harnesses.
// Functions here run inside the page (Playwright serialises them): keep each self-contained.

export const globMatch = (pattern, value) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`).test(value);

/**
 * Collects layout shifts from navigation start (CLS without the session
 * window: the total, which is the stricter number for a short page load).
 */
export const CLS_INIT = () => {
  window.__galleryCls = 0;
  window.__galleryShifts = [];
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.hadRecentInput) continue;
        window.__galleryCls += entry.value;
        const source = entry.sources?.[0]?.node;
        if (source && window.__galleryShifts.length < 5) {
          window.__galleryShifts.push(source.nodeType === 1 ? source.tagName.toLowerCase() + (source.id ? `#${source.id}` : "") + (source.className && typeof source.className === "string" ? `.${source.className.trim().split(/\s+/).slice(0, 2).join(".")}` : "") : "text");
        }
      }
    }).observe({ type: "layout-shift", buffered: true });
  } catch {
    // No layout-shift support: CLS reads as 0.
  }
};

/** Focus each marked control by script after a Tab press and compare its look with and without focus. */
export function focusVisibleCheck() {
  const keys = ["outlineStyle", "outlineWidth", "outlineColor", "boxShadow", "borderTopColor", "borderBottomColor", "borderTopWidth", "backgroundColor", "color", "textDecorationLine"];
  const ringKeys = ["outlineStyle", "outlineWidth", "outlineColor", "boxShadow"];
  // The control and its pseudo-elements, its two nearest ancestors fully, and
  // rings up to six levels up (a card draws a stretched link's ring).
  const snapshot = (element) => {
    const parts = [];
    let node = element;
    for (let depth = 0; node && depth < 7; depth += 1, node = node.parentElement) {
      const style = getComputedStyle(node);
      parts.push((depth < 3 ? keys : ringKeys).map((key) => style[key]).join("|"));
      if (depth === 0) {
        for (const pseudo of ["::before", "::after"]) {
          const decoration = getComputedStyle(node, pseudo);
          parts.push(`${decoration.outlineStyle}|${decoration.boxShadow}|${decoration.borderTopColor}|${decoration.backgroundColor}|${decoration.opacity}`);
        }
      }
    }
    return parts.join("||");
  };
  const missing = [];
  let judged = 0;
  for (const element of document.querySelectorAll("[data-quality-focus]")) {
    element.blur();
    const before = snapshot(element);
    element.focus({ preventScroll: true });
    if (document.activeElement !== element) continue;
    if (!element.matches(":focus-visible")) continue;
    judged += 1;
    const after = snapshot(element);
    if (before === after) missing.push(element);
    element.blur();
  }
  const describe = (element) => element.tagName.toLowerCase() + (element.id ? `#${element.id}` : "") + (element.getAttribute("aria-label") ? `[aria-label="${element.getAttribute("aria-label")}"]` : element.textContent?.trim() ? ` "${element.textContent.trim().slice(0, 40)}"` : "");
  return { judged, missing: missing.slice(0, 10).map(describe), count: missing.length };
}
