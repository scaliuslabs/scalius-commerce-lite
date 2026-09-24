/**
 * Header navigation behaviour: the WAI-ARIA disclosure pattern (buttons with
 * `aria-expanded`/`aria-controls`, never `role="menu"`), installed once with
 * delegated listeners so server-rendered menus need no per-element setup.
 *
 * Markup contract:
 * - `button[data-disclosure][aria-controls]` shows or hides the element with
 *   that id through its `hidden` attribute.
 * - `data-disclosure="tree"`: sidebar and drawer levels, each independent.
 * - `data-disclosure="popup"`: a dropdown or mega panel inside its
 *   `[data-disclosure-item]`. One popup is open at a time. Escape, a press
 *   outside and focus leaving the item close it; Escape returns focus to the
 *   button. A mouse hovering the item opens it after a short intent delay.
 * - `ul[data-nav-overflow]`: top-level items that don't fit move into the
 *   list's "More" item (`[data-nav-more]`, entries `[data-nav-more-index]`).
 * - `[data-pill-scroller]`: the current pill is scrolled into view.
 */

const POPUP = 'button[data-disclosure="popup"]';
const HOVER_OPEN_MS = 80;
const HOVER_CLOSE_MS = 180;
const DESKTOP = "(min-width: 64rem)";
const DROPDOWN_WIDTH_PX = 288;

type NavWindow = Window & { __scaliusNavDisclosure?: boolean };

function panelFor(button: Element): HTMLElement | null {
  const id = button.getAttribute("aria-controls");
  return id ? button.ownerDocument.getElementById(id) : null;
}

export function isDisclosureOpen(button: Element): boolean {
  return button.getAttribute("aria-expanded") === "true";
}

export function setDisclosureOpen(button: HTMLElement, open: boolean): void {
  const panel = panelFor(button);
  if (!panel) return;
  button.setAttribute("aria-expanded", String(open));
  panel.hidden = !open;
  if (!open) delete button.dataset.hoverOpen;
}

function openPopups(doc: Document): HTMLElement[] {
  return Array.from(doc.querySelectorAll<HTMLElement>(`${POPUP}[aria-expanded="true"]`));
}

function popupButton(item: Element): HTMLElement | null {
  return item.querySelector<HTMLElement>(`:scope > ${POPUP}`);
}

function openPopup(button: HTMLElement, viaHover: boolean): void {
  for (const other of openPopups(button.ownerDocument)) {
    if (other !== button) setDisclosureOpen(other, false);
  }
  setDisclosureOpen(button, true);
  if (viaHover) button.dataset.hoverOpen = "";
}

/**
 * Hides the top-level items that don't fit on one line and lists them in the
 * "More" dropdown instead; dropdowns near the right edge align to their item's
 * end so they stay on screen. Reads every width before writing.
 */
export function fitNavOverflow(list: HTMLElement): void {
  const items = Array.from(list.querySelectorAll<HTMLElement>(":scope > [data-nav-index]"));
  const more = list.querySelector<HTMLElement>(":scope > [data-nav-more]");
  if (!more) return;
  const moreButton = popupButton(more);
  if (moreButton && isDisclosureOpen(moreButton)) setDisclosureOpen(moreButton, false);
  for (const item of items) item.hidden = false;
  more.hidden = false;

  const available = list.clientWidth;
  if (available <= 0) return;
  const gap = Number.parseFloat(getComputedStyle(list).columnGap) || 0;
  const moreWidth = more.offsetWidth;
  const widths = items.map((item) => item.offsetWidth);

  const total = widths.reduce((sum, width) => sum + width, 0) + gap * Math.max(0, items.length - 1);
  let cut = items.length;
  if (total > available) {
    let used = moreWidth;
    cut = 0;
    while (cut < items.length && used + gap + widths[cut]! <= available) {
      used += gap + widths[cut]!;
      cut += 1;
    }
  }

  items.forEach((item, index) => {
    const button = popupButton(item);
    if (index >= cut && button && isDisclosureOpen(button)) setDisclosureOpen(button, false);
    item.hidden = index >= cut;
  });
  more.hidden = cut === items.length;
  more.querySelectorAll<HTMLElement>("[data-nav-more-index]").forEach((entry) => {
    entry.hidden = Number(entry.dataset.navMoreIndex) < cut;
  });

  // Dropdowns that would pass the list's end open towards the start.
  const listLeft = list.getBoundingClientRect().left;
  const ends = items.map((item) => item.getBoundingClientRect().left - listLeft + DROPDOWN_WIDTH_PX);
  items.forEach((item, index) => item.toggleAttribute("data-align-end", ends[index]! > available));
}

const observed = new WeakSet<HTMLElement>();

function fitAll(doc: Document): void {
  const view = doc.defaultView;
  doc.querySelectorAll<HTMLElement>("[data-nav-overflow]").forEach((list) => {
    // Phones never lay the desktop menu out, so don't measure it there.
    if (view?.matchMedia(DESKTOP).matches) {
      fitNavOverflow(list);
      if (!observed.has(list) && typeof ResizeObserver !== "undefined") {
        observed.add(list);
        let frame = 0;
        new ResizeObserver(() => {
          cancelAnimationFrame(frame);
          frame = requestAnimationFrame(() => fitNavOverflow(list));
        }).observe(list);
      }
    }
    list.removeAttribute("data-nav-pending");
  });
}

/** Scrolls each pill row so its current pill is in view (no page scroll). */
export function revealCurrentPill(doc: Document): void {
  doc.querySelectorAll<HTMLElement>("[data-pill-scroller]").forEach((scroller) => {
    const current = scroller.querySelector<HTMLElement>("[aria-current]");
    if (!current || scroller.scrollWidth <= scroller.clientWidth) return;
    const left = current.offsetLeft - scroller.offsetLeft;
    const right = left + current.offsetWidth;
    if (left >= scroller.scrollLeft && right <= scroller.scrollLeft + scroller.clientWidth) return;
    scroller.scrollLeft = left - (scroller.clientWidth - current.offsetWidth) / 2;
  });
}

export function installNavDisclosure(doc: Document = document): void {
  const view = doc.defaultView as NavWindow | null;
  if (!view || view.__scaliusNavDisclosure) return;
  view.__scaliusNavDisclosure = true;

  const timers = new Map<HTMLElement, number>();
  const clearTimer = (button: HTMLElement) => {
    const timer = timers.get(button);
    if (timer !== undefined) view.clearTimeout(timer);
    timers.delete(button);
  };
  const later = (button: HTMLElement, ms: number, run: () => void) => {
    clearTimer(button);
    timers.set(
      button,
      view.setTimeout(() => {
        timers.delete(button);
        run();
      }, ms),
    );
  };

  doc.addEventListener("click", (event) => {
    const button = (event.target as Element | null)?.closest<HTMLElement>("button[data-disclosure]");
    if (!button || !panelFor(button)) return;
    event.preventDefault();
    clearTimer(button);
    if (button.dataset.disclosure !== "popup") {
      setDisclosureOpen(button, !isDisclosureOpen(button));
    } else if (isDisclosureOpen(button) && button.dataset.hoverOpen !== undefined) {
      // Hover already opened it: the click keeps it open until dismissed.
      delete button.dataset.hoverOpen;
    } else if (isDisclosureOpen(button)) {
      setDisclosureOpen(button, false);
    } else {
      openPopup(button, false);
    }
  });

  doc.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    for (const button of openPopups(doc)) {
      const item = button.closest("[data-disclosure-item]");
      const hadFocus = Boolean(item && doc.activeElement && item.contains(doc.activeElement));
      setDisclosureOpen(button, false);
      if (hadFocus) {
        event.preventDefault();
        button.focus();
      }
    }
  });

  doc.addEventListener("pointerdown", (event) => {
    const target = event.target as Node | null;
    for (const button of openPopups(doc)) {
      const item = button.closest("[data-disclosure-item]");
      if (!item || !target || !item.contains(target)) setDisclosureOpen(button, false);
    }
  });

  doc.addEventListener("focusout", (event) => {
    const next = event.relatedTarget as Node | null;
    const item = (event.target as Element | null)?.closest("[data-disclosure-item]");
    const button = item && popupButton(item);
    // A press on a non-focusable spot has no relatedTarget; pointerdown owns it.
    if (!button || !next || item.contains(next) || !isDisclosureOpen(button)) return;
    setDisclosureOpen(button, false);
  });

  doc.addEventListener("pointerover", (event) => {
    if (event.pointerType !== "mouse") return;
    const item = (event.target as Element | null)?.closest("[data-disclosure-item]");
    const button = item && popupButton(item);
    if (!button) return;
    clearTimer(button);
    if (isDisclosureOpen(button)) return;
    const switching = openPopups(doc).length > 0;
    later(button, switching ? 0 : HOVER_OPEN_MS, () => openPopup(button, true));
  });

  doc.addEventListener("pointerout", (event) => {
    if (event.pointerType !== "mouse") return;
    const item = (event.target as Element | null)?.closest("[data-disclosure-item]");
    const button = item && popupButton(item);
    const next = event.relatedTarget as Node | null;
    if (!button || (next && item.contains(next))) return;
    if (!isDisclosureOpen(button)) {
      clearTimer(button);
    } else if (button.dataset.hoverOpen !== undefined) {
      later(button, HOVER_CLOSE_MS, () => setDisclosureOpen(button, false));
    }
  });

  const refresh = () => {
    fitAll(doc);
    revealCurrentPill(doc);
  };
  refresh();
  view.matchMedia(DESKTOP).addEventListener("change", (event) => {
    for (const button of openPopups(doc)) setDisclosureOpen(button, false);
    if (event.matches) refresh();
  });
  doc.addEventListener("astro:page-load", refresh);
}
