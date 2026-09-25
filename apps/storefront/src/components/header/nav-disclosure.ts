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
 * - `ul[data-nav-overflow]`: top-level items (`[data-nav-index]`) that don't
 *   fit move, as they are, into the row's "More" item (`[data-nav-more]`,
 *   list `[data-nav-more-list]`), so each link is in the page once (the
 *   header link budget, nav-tree.ts). Refitted on resize and once the fonts
 *   have loaded. Without JavaScript the row wraps instead (a <noscript> rule).
 * - `[data-nav-compact-from="<nav id>"]`: the condensed classic header's bar;
 *   the menu moves there on scroll and back to `[data-nav-compact-home]`.
 * - Arrow keys: Left/Right/Home/End move along a menu row, Down opens a
 *   popup and enters it, Up/Down/Home/End move inside an open popup.
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

/**
 * The disclosure item an event belongs to: a row item moved into "More" is
 * a plain row of the More list there, so the More item answers for it.
 */
function disclosureItem(node: Element | null | undefined): Element | null {
  const item = node?.closest("[data-disclosure-item]") ?? null;
  const moreList = item?.parentElement?.closest("[data-nav-more-list]");
  return moreList ? moreList.closest("[data-disclosure-item]") : item;
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

/** The row items of a menu row, wherever they currently sit (the row or its "More" list), in menu order. */
function rowItems(list: HTMLElement): HTMLElement[] {
  const more = list.querySelector<HTMLElement>(":scope > [data-nav-more]");
  const moved = more ? Array.from(more.querySelectorAll<HTMLElement>("[data-nav-more-list] > [data-nav-index]")) : [];
  return [...Array.from(list.querySelectorAll<HTMLElement>(":scope > [data-nav-index]")), ...moved].sort(
    (a, b) => Number(a.dataset.navIndex) - Number(b.dataset.navIndex),
  );
}

function closeWithin(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>(`${POPUP}[aria-expanded="true"]`).forEach((button) => setDisclosureOpen(button, false));
  root.querySelectorAll("details[open]").forEach((menu) => menu.removeAttribute("open"));
}

/**
 * Fits a menu row (`[data-nav-overflow]`) on one line: the items that don't
 * fit move, as they are, into the row's "More" list, ahead of the entries
 * the server put there (roots past `maxTopItems`, "All categories"), so
 * every link stays in the page exactly once. Dropdowns near the row's end
 * align to their item's end so they stay on screen. Reads every width
 * before moving anything.
 */
export function fitNavOverflow(list: HTMLElement): void {
  const more = list.querySelector<HTMLElement>(":scope > [data-nav-more]");
  const moreList = more?.querySelector<HTMLElement>("[data-nav-more-list]");
  if (!more || !moreList) return;
  closeWithin(more);
  const items = rowItems(list);
  for (const item of items) {
    closeWithin(item);
    list.insertBefore(item, more);
    item.hidden = false;
  }
  const extras = moreList.querySelector(":scope > :not([data-nav-index])") !== null;
  more.hidden = false;

  const available = list.clientWidth;
  if (available <= 0) return;
  const view = list.ownerDocument.defaultView;
  const gap = view ? Number.parseFloat(view.getComputedStyle(list).columnGap) || 0 : 0;
  const moreWidth = more.offsetWidth;
  const widths = items.map((item) => item.offsetWidth);
  const total = widths.reduce((sum, width) => sum + width, 0) + gap * Math.max(0, items.length - 1);

  let cut = items.length;
  if (extras ? total + gap + moreWidth > available : total > available) {
    let used = moreWidth;
    cut = 0;
    while (cut < items.length && used + gap + widths[cut]! <= available) {
      used += gap + widths[cut]!;
      cut += 1;
    }
  }
  const firstExtra = moreList.firstElementChild;
  for (const item of items.slice(cut)) moreList.insertBefore(item, firstExtra);
  more.hidden = cut === items.length && !extras;
  list.toggleAttribute("data-nav-overflowing", !more.hidden);

  // Dropdowns that would pass the row's end open towards its start.
  if (typeof list.getBoundingClientRect !== "function") return;
  const listLeft = list.getBoundingClientRect().left;
  items.slice(0, cut).forEach((item) => {
    item.toggleAttribute("data-align-end", item.getBoundingClientRect().left - listLeft + DROPDOWN_WIDTH_PX > available);
  });
}

/**
 * The condensed classic header shows the menu in its bar: on scroll the
 * menu itself moves into `[data-nav-compact-from="<nav id>"]` and back, so
 * it is in the page once (the header link budget) and keeps its state.
 */
export function placeCompactMenus(doc: Document): void {
  doc.querySelectorAll<HTMLElement>("[data-nav-compact-from]").forEach((slot) => {
    const header = slot.closest<HTMLElement>("#main-header");
    const nav = doc.getElementById(slot.dataset.navCompactFrom ?? "");
    if (!header || !nav) return;
    const home = doc.querySelector<HTMLElement>(`[data-nav-compact-home="${nav.id}"]`);
    if (!home) return;
    const compact = header.classList.contains("is-scrolled");
    const target = compact ? slot : home;
    if (nav.parentElement === target) return;
    closeWithin(nav);
    target.append(nav);
  });
}

const ROW_CONTROL = ":scope > a.desktop-nav-link, :scope > button.desktop-nav-link, :scope > span.desktop-nav-link";

function rowControls(list: Element): HTMLElement[] {
  return Array.from(list.querySelectorAll<HTMLElement>(":scope > [data-nav-index], :scope > [data-nav-more]"))
    .filter((item) => !item.hidden)
    .map((item) => item.querySelector<HTMLElement>(ROW_CONTROL))
    .filter((control): control is HTMLElement => control !== null && control.tagName !== "SPAN");
}

function panelLinks(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>("a[href]")).filter((link) => {
    const hidden = link.parentElement?.closest("[hidden]");
    return !hidden || hidden === panel;
  });
}

/** Arrow keys along a menu row (`[data-nav-overflow]`) and inside its open popups. */
export function handleDisclosureKey(event: KeyboardEvent): void {
  const target = event.target as HTMLElement | null;
  const list = target?.closest<HTMLElement>("[data-nav-overflow]");
  // <details> menus have their own keys (nav-menus.ts).
  if (!target || !list || target.closest("[data-menu-root]")) return;
  const key = event.key;
  const item = target.closest<HTMLElement>("[data-nav-more]") ?? target.closest<HTMLElement>("[data-nav-index]");
  const button = item?.querySelector<HTMLElement>(`:scope > ${POPUP}`) ?? null;
  const panel = button ? panelFor(button) : null;

  if (panel && button && panel.contains(target)) {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(key)) return;
    const links = panelLinks(panel);
    const index = links.indexOf(target);
    const last = links.length - 1;
    const next = key === "Home" ? 0 : key === "End" ? last : key === "ArrowDown" ? index + 1 : index - 1;
    event.preventDefault();
    if (next < 0) button.focus();
    else links[Math.min(next, last)]?.focus();
    return;
  }

  if (key === "ArrowLeft" || key === "ArrowRight" || key === "Home" || key === "End") {
    const row = rowControls(list);
    const current = row.findIndex((control) => control.closest("li") === item);
    if (current < 0) return;
    const next =
      key === "Home"
        ? 0
        : key === "End"
          ? row.length - 1
          : key === "ArrowRight"
            ? (current + 1) % row.length
            : (current - 1 + row.length) % row.length;
    event.preventDefault();
    row[next]?.focus();
    return;
  }
  if ((key === "ArrowDown" || key === "ArrowUp") && button && panel) {
    event.preventDefault();
    openPopup(button, false);
    const links = panelLinks(panel);
    (key === "ArrowDown" ? links[0] : links.at(-1))?.focus();
  }
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

  doc.addEventListener("keydown", handleDisclosureKey);

  doc.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    for (const button of openPopups(doc)) {
      const item = disclosureItem(button);
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
      const item = disclosureItem(button);
      if (!item || !target || !item.contains(target)) setDisclosureOpen(button, false);
    }
  });

  doc.addEventListener("focusout", (event) => {
    const next = event.relatedTarget as Node | null;
    const item = disclosureItem(event.target as Element | null);
    const button = item && popupButton(item);
    // A press on a non-focusable spot has no relatedTarget; pointerdown owns it.
    if (!button || !next || item.contains(next) || !isDisclosureOpen(button)) return;
    setDisclosureOpen(button, false);
  });

  doc.addEventListener("pointerover", (event) => {
    if (event.pointerType !== "mouse") return;
    const item = disclosureItem(event.target as Element | null);
    const button = item && popupButton(item);
    // "More" opens on a press only (its rows are the moved items).
    if (!button || item.hasAttribute("data-nav-more")) return;
    clearTimer(button);
    if (isDisclosureOpen(button)) return;
    const switching = openPopups(doc).length > 0;
    later(button, switching ? 0 : HOVER_OPEN_MS, () => openPopup(button, true));
  });

  doc.addEventListener("pointerout", (event) => {
    if (event.pointerType !== "mouse") return;
    const item = disclosureItem(event.target as Element | null);
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
    placeCompactMenus(doc);
    fitAll(doc);
    revealCurrentPill(doc);
  };
  refresh();
  // Web fonts change every label's width: fit again once they are in.
  void doc.fonts?.ready.then(() => fitAll(doc));
  // The classic header's menu follows its condensed state.
  const header = doc.getElementById("main-header");
  if (header?.querySelector("[data-nav-compact-from]") && typeof MutationObserver !== "undefined") {
    new MutationObserver(() => placeCompactMenus(doc)).observe(header, { attributes: true, attributeFilter: ["class"] });
  }
  view.matchMedia(DESKTOP).addEventListener("change", (event) => {
    for (const button of openPopups(doc)) setDisclosureOpen(button, false);
    if (event.matches) refresh();
  });
  doc.addEventListener("astro:page-load", refresh);
}
