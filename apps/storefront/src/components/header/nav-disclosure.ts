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
 *   The entries are built here from the menu itself and a
 *   `template[data-nav-more-template]`, so the server HTML carries each link
 *   once (the header link budget, nav-tree.ts).
 * - `[data-nav-compact-from="<nav id>"]`: filled with a copy of that menu
 *   (ids suffixed `-compact`) for the condensed classic header.
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
    if (index >= cut) item.querySelectorAll("details[open]").forEach((menu) => menu.removeAttribute("open"));
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

interface MoreLink {
  title: string;
  attributes: Array<[string, string]>;
}

const COPIED_LINK_ATTRIBUTES = ["href", "target", "rel", "aria-current", "data-astro-prefetch"];

function moreLink(element: Element | null, title?: string): MoreLink | null {
  if (!element) return null;
  const text = (title ?? element.textContent ?? "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  const attributes = COPIED_LINK_ATTRIBUTES.flatMap((name): Array<[string, string]> => {
    const value = element.getAttribute(name);
    return element.tagName === "A" && value !== null ? [[name, value]] : [];
  });
  return { title: text, attributes };
}

/** An item's top link and its first-level links, read from the rendered menu. */
function moreItem(item: HTMLElement): { parent: MoreLink; children: MoreLink[] } | null {
  const doc = item.ownerDocument;
  const link = item.querySelector(":scope > a.desktop-nav-link, :scope > a[data-menu-top-link]");
  const button = item.querySelector<HTMLElement>(":scope > button[data-disclosure]");
  const summary = item.querySelector<HTMLElement>(":scope > details > summary");
  const label = button?.querySelector(".sr-only") ? "" : button?.textContent ?? "";
  const parent = link ? moreLink(link) : button ? moreLink(button, label) : moreLink(summary);
  if (!parent) return null;
  const panel = button ? doc.getElementById(button.getAttribute("aria-controls") ?? "") : null;
  const children: MoreLink[] = [];
  if (panel?.matches(".mega-panel")) {
    panel.querySelectorAll(".mega-column > .mega-column-heading").forEach((heading) => {
      const entry = moreLink(heading, heading.querySelector(".mega-column-title")?.textContent ?? "");
      if (entry) children.push(entry);
    });
  } else if (panel) {
    panel.querySelectorAll(":scope > ul > li > .nav-dropdown-link").forEach((child) => {
      const entry = moreLink(child);
      if (entry) children.push(entry);
    });
  } else if (summary) {
    // A <details> menu (cascading, category bar): its first column, without "Show all".
    const rows = ":scope > details > [data-menu-panel] > ul > li:not(.fly-row--all)";
    item
      .querySelectorAll(`${rows} > a, ${rows} > span, ${rows}:not(:has(> a)) > details > summary`)
      .forEach((child) => {
        const entry = moreLink(child);
        if (entry) children.push(entry);
      });
  }
  return { parent, children };
}

/** Puts a link's text and attributes on a prototype element (a link or plain text). */
function fill(element: Element, link: MoreLink): Element {
  const doc = element.ownerDocument;
  let target = element;
  const isLink = link.attributes.some(([name]) => name === "href");
  if (isLink !== (element.tagName === "A")) {
    target = doc.createElement(isLink ? "a" : "span");
    for (const attribute of Array.from(element.attributes)) {
      if (!COPIED_LINK_ATTRIBUTES.includes(attribute.name)) target.setAttribute(attribute.name, attribute.value);
    }
    element.replaceWith(target);
  }
  for (const name of COPIED_LINK_ATTRIBUTES) target.removeAttribute(name);
  for (const [name, value] of link.attributes) target.setAttribute(name, value);
  target.textContent = link.title;
  return target;
}

/**
 * Builds the "More" entries of a menu row from its own items (once): each
 * top link with its first-level links, from the prototype entry in
 * `template[data-nav-more-template]` (so they carry the menu's styles).
 */
export function buildNavMoreEntries(list: HTMLElement): void {
  const target = list.querySelector<HTMLElement>(":scope > [data-nav-more] [data-nav-more-list]");
  const template = list.parentElement?.querySelector<HTMLTemplateElement>(":scope > template[data-nav-more-template]");
  if (!target || !template || target.querySelector("[data-nav-more-index]")) return;
  const prototype = template.content.firstElementChild;
  if (!prototype) return;
  for (const item of Array.from(list.querySelectorAll<HTMLElement>(":scope > [data-nav-index]"))) {
    const data = moreItem(item);
    if (!data) continue;
    const entry = prototype.cloneNode(true) as HTMLElement;
    entry.setAttribute("data-nav-more-index", item.dataset.navIndex ?? "");
    entry.hidden = true;
    const parent = fill(entry.querySelector(".nav-dropdown-link--parent, [data-more-parent]")!, data.parent);
    const sublist = entry.querySelector(".nav-dropdown-sublist, [data-more-sublist]");
    const childPrototype = sublist?.firstElementChild ?? null;
    if (sublist && childPrototype && data.children.length > 0) {
      sublist.replaceChildren();
      for (const child of data.children) {
        const row = childPrototype.cloneNode(true) as HTMLElement;
        fill(row.firstElementChild!, child);
        sublist.append(row);
      }
    } else {
      // A parent without children is a plain row.
      sublist?.remove();
      parent.classList.remove("nav-dropdown-link--parent");
    }
    target.append(entry);
  }
}

/** Fills each compact-menu slot with a copy of its menu (ids suffixed `-compact`). */
export function cloneCompactMenus(doc: Document): void {
  doc.querySelectorAll<HTMLElement>("[data-nav-compact-from]").forEach((slot) => {
    if (slot.querySelector("nav")) return;
    const sourceId = slot.dataset.navCompactFrom ?? "";
    const source = doc.getElementById(sourceId);
    if (!source) return;
    const copy = source.cloneNode(true) as HTMLElement;
    const suffix = (value: string) =>
      value.startsWith(sourceId) ? `${sourceId}-compact${value.slice(sourceId.length)}` : value;
    for (const element of [copy, ...Array.from(copy.querySelectorAll<HTMLElement>("[id], [aria-controls]"))]) {
      if (element.id) element.id = suffix(element.id);
      const controls = element.getAttribute("aria-controls");
      if (controls) element.setAttribute("aria-controls", suffix(controls));
    }
    // The copy starts closed and builds its own "More" entries.
    copy.querySelectorAll<HTMLElement>('[aria-expanded="true"]').forEach((button) => {
      button.setAttribute("aria-expanded", "false");
      const panel = copy.querySelector<HTMLElement>(`#${CSS.escape(button.getAttribute("aria-controls") ?? "")}`);
      if (panel) panel.hidden = true;
    });
    copy.querySelectorAll("[data-nav-more-index]").forEach((entry) => entry.remove());
    copy.querySelectorAll("[data-align-end]").forEach((item) => item.removeAttribute("data-align-end"));
    copy.querySelectorAll<HTMLElement>("[data-nav-index][hidden], [data-nav-more]").forEach((item) => {
      item.hidden = item.hasAttribute("data-nav-more");
    });
    slot.append(copy);
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
  const item = target.closest<HTMLElement>("[data-nav-index], [data-nav-more]");
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
    buildNavMoreEntries(list);
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
    cloneCompactMenus(doc);
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
