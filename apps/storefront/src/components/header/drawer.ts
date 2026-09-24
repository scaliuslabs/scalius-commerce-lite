/**
 * The header's drawers (the phone menu, and the desktop "All" drawer of the
 * drill-in pattern): a modal dialog that slides in from the start edge.
 *
 * Without JavaScript the drawer opens as the URL's `:target` from a
 * `<noscript>` link (MobileMenu.astro). With it, this controller owns the
 * state: openers get `aria-expanded`, the page behind turns inert, focus is
 * trapped and returns to the opener, Escape and the backdrop close it, and
 * the browser Back button closes it (one history entry while open).
 */

export interface DrawerElements {
  panel: HTMLElement;
  overlay: HTMLElement;
  closeButton: HTMLElement | null;
  /** Every control that opens this drawer; focus returns to the one used. */
  openers: HTMLElement[];
  /** The history-state key marking this drawer open. */
  historyKey: string;
  /** Close it when the viewport reaches desktop width (the phone menu). */
  phoneOnly: boolean;
  /** Called on open, before the drawer shows (deferred images). */
  onOpen?: () => void;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

/** What turns inert while a drawer is open: everything outside it. */
function backgroundElements(panel: HTMLElement, overlay: HTMLElement): Set<HTMLElement> {
  const elements = new Set<HTMLElement>();
  const keep = (element: Element) =>
    element !== panel && element !== overlay && !element.contains(panel) && !["SCRIPT", "STYLE", "NOSCRIPT"].includes(element.tagName);
  // Walk up from the panel: every sibling of each ancestor goes inert.
  for (let node: HTMLElement | null = panel; node && node !== document.body; node = node.parentElement) {
    const parent: HTMLElement | null = node.parentElement;
    if (!parent) break;
    for (const sibling of Array.from(parent.children)) {
      if (sibling instanceof HTMLElement && sibling !== node && keep(sibling)) elements.add(sibling);
    }
  }
  return elements;
}

/** Installs one drawer; returns its cleanup. */
export function installDrawer(elements: DrawerElements): () => void {
  const { panel, overlay, closeButton, openers, historyKey, phoneOnly, onOpen } = elements;
  let opener: HTMLElement | null = openers[0] ?? null;
  let isOpen = false;
  let bodyOverflowBefore = "";
  let visibilityTimer: number | undefined;
  const inertBefore = new Map<HTMLElement, boolean>();
  const desktop = window.matchMedia("(min-width: 1024px)");

  // JavaScript owns the state from here: closed, out of the tab order and
  // out of the accessibility tree (the server markup relies on visibility).
  panel.inert = true;
  panel.setAttribute("aria-hidden", "true");

  const historyState = (): Record<string, unknown> =>
    history.state && typeof history.state === "object" ? history.state : {};
  const clearHistoryMarker = () => {
    const next = { ...historyState() };
    delete next[historyKey];
    history.replaceState(next, "", window.location.href);
  };

  const setBackgroundInert = (inert: boolean) => {
    if (inert) {
      backgroundElements(panel, overlay).forEach((element) => {
        inertBefore.set(element, element.inert);
        element.inert = true;
      });
      return;
    }
    inertBefore.forEach((was, element) => (element.inert = was));
    inertBefore.clear();
  };

  // Rendered and visible (drill-in levels hide the rows they cover).
  const focusable = () =>
    Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (element) =>
        (element.offsetParent !== null || element.getClientRects().length > 0) &&
        getComputedStyle(element).visibility !== "hidden",
    );

  const toggle = (show: boolean, options: { syncHistory?: boolean; restoreFocus?: boolean } = {}) => {
    const syncHistory = options.syncHistory ?? true;
    const restoreFocus = options.restoreFocus ?? true;
    if (show === isOpen) return;
    isOpen = show;
    if (visibilityTimer !== undefined) {
      window.clearTimeout(visibilityTimer);
      visibilityTimer = undefined;
    }
    panel.inert = !show;
    panel.setAttribute("aria-hidden", String(!show));
    openers.forEach((each) => each.setAttribute("aria-expanded", String(show)));
    if (show) {
      onOpen?.();
      setBackgroundInert(true);
      bodyOverflowBefore = document.body.style.overflow;
      panel.classList.remove("invisible");
      overlay.classList.remove("invisible");
      requestAnimationFrame(() => {
        if (!isOpen) return;
        panel.classList.remove("-translate-x-full");
        overlay.classList.remove("opacity-0", "pointer-events-none");
      });
      document.body.style.overflow = "hidden";
      if (syncHistory && historyState()[historyKey] !== true) {
        history.pushState({ ...historyState(), [historyKey]: true }, "", window.location.href);
      }
      requestAnimationFrame(() => closeButton?.focus());
    } else {
      setBackgroundInert(false);
      panel.classList.add("-translate-x-full");
      overlay.classList.add("opacity-0", "pointer-events-none");
      visibilityTimer = window.setTimeout(() => {
        if (isOpen) return;
        panel.classList.add("invisible");
        overlay.classList.add("invisible");
        visibilityTimer = undefined;
      }, 300);
      document.body.style.overflow = bodyOverflowBefore;
      if (restoreFocus) opener?.focus();
      if (syncHistory && historyState()[historyKey] === true) history.back();
    }
  };

  const onPopState = () => {
    if (isOpen) toggle(false, { syncHistory: false });
  };
  window.addEventListener("popstate", onPopState);

  openers.forEach((each) => {
    each.onclick = (event) => {
      event.preventDefault();
      opener = each;
      toggle(true);
    };
  });
  if (closeButton) closeButton.onclick = () => toggle(false);
  overlay.onclick = () => toggle(false);

  panel.onkeydown = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      toggle(false);
      return;
    }
    if (event.key !== "Tab") return;
    const items = focusable();
    const first = items.at(0);
    const last = items.at(-1);
    if (!first || !last) {
      event.preventDefault();
      return;
    }
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  // Menu levels are disclosures; following a link closes the drawer.
  panel.onclick = (event) => {
    if ((event.target as HTMLElement).closest("a[href]")) {
      toggle(false, { syncHistory: false, restoreFocus: false });
      if (historyState()[historyKey] === true) clearHistoryMarker();
    }
  };

  const onBreakpoint = (event: MediaQueryListEvent) => {
    if (phoneOnly && event.matches && isOpen) toggle(false);
  };
  desktop.addEventListener("change", onBreakpoint);

  return () => {
    window.removeEventListener("popstate", onPopState);
    desktop.removeEventListener("change", onBreakpoint);
    openers.forEach((each) => (each.onclick = null));
    panel.onkeydown = null;
    panel.onclick = null;
    overlay.onclick = null;
    if (closeButton) closeButton.onclick = null;
    if (isOpen) toggle(false, { syncHistory: false, restoreFocus: false });
    if (visibilityTimer !== undefined) window.clearTimeout(visibilityTimer);
    panel.classList.add("invisible");
    overlay.classList.add("invisible");
  };
}
