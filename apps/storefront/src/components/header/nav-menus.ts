/**
 * Behaviour for the `<details>` menus (cascading, category bar, departments
 * rail, drill-in drawer). The markup works without JavaScript: each level is
 * a native `<details>`/`<summary>` disclosure. This module adds what a
 * shopper expects on top:
 *
 * - one menu open at a time inside a `[data-menu-root]` (opening one closes
 *   every open menu that is not its ancestor);
 * - popups (`details[data-menu="popup"]`) close on a press outside, when
 *   focus leaves the root, and on Escape (focus returns to the summary);
 * - mouse hover opens `details[data-menu-hover]` after a short intent delay;
 *   a click then pins it open;
 * - arrow keys: along a bar (`[data-menu-bar]`: Left/Right/Home/End, Down
 *   opens), in a list (`[data-menu-list]`: Up/Down/Home/End, Right opens a
 *   fly-out or drills in, Left goes back);
 * - drill levels (`details[data-menu="drill"]`) close one level per Escape;
 *   at the top level Escape is left to the drawer;
 * - a panel that would pass the viewport's end opens towards the start
 *   (`data-flip`), so nothing overflows the page.
 */

const HOVER_OPEN_MS = 80;
const HOVER_CLOSE_MS = 180;
const MENU = "details[data-menu]";

type MenuWindow = Window & { __scaliusNavMenus?: boolean };

const isMenu = (node: Element | null): node is HTMLDetailsElement =>
  node instanceof Element && node.matches(MENU);

function rootOf(menu: Element): Element | null {
  return menu.closest("[data-menu-root]");
}

function summaryOf(menu: HTMLDetailsElement): HTMLElement | null {
  return menu.querySelector<HTMLElement>(":scope > summary");
}

/** Open menus in a root, innermost last. */
function openMenus(root: ParentNode): HTMLDetailsElement[] {
  return Array.from(root.querySelectorAll<HTMLDetailsElement>(`${MENU}[open]`));
}

/** Opens or closes a menu, closing every other open menu in its root that is not an ancestor. */
export function setMenuOpen(menu: HTMLDetailsElement, open: boolean): void {
  if (open) {
    const root = rootOf(menu);
    if (root) {
      for (const other of openMenus(root)) {
        if (other !== menu && !other.contains(menu)) closeMenu(other);
      }
    }
  }
  if (menu.open !== open) menu.open = open;
  if (!open) delete menu.dataset.hoverOpen;
  if (open) flipIfNeeded(menu);
}

function closeMenu(menu: HTMLDetailsElement): void {
  // Close the open descendants too, so reopening starts at the first level.
  for (const inner of openMenus(menu)) {
    inner.open = false;
    delete inner.dataset.hoverOpen;
  }
  menu.open = false;
  delete menu.dataset.hoverOpen;
}

/** A panel past the viewport's end opens towards the start instead. */
export function flipIfNeeded(menu: HTMLDetailsElement): void {
  const panel = menu.querySelector<HTMLElement>(":scope > [data-menu-panel]");
  if (!panel) return;
  menu.removeAttribute("data-flip");
  const view = menu.ownerDocument.defaultView;
  const width = view?.innerWidth ?? 0;
  if (width <= 0) return;
  const rect = panel.getBoundingClientRect();
  if (rect.right > width - 8) menu.setAttribute("data-flip", "");
}

/** The control that stands for a row: its link, or the summary of a row without one. */
function rowControl(row: Element): HTMLElement | null {
  return row.querySelector<HTMLElement>(":scope > a, :scope > details > summary");
}

function controls(list: Element): HTMLElement[] {
  return Array.from(list.children)
    .filter((child) => child.tagName === "LI" && !(child as HTMLElement).hidden)
    .map(rowControl)
    .filter((control): control is HTMLElement => control !== null);
}

/** The menu a row opens (its own details), if any. */
function rowMenu(row: Element): HTMLDetailsElement | null {
  return row.querySelector<HTMLDetailsElement>(":scope > details[data-menu]");
}

/** First control inside a menu's panel. */
function firstInside(menu: HTMLDetailsElement): HTMLElement | null {
  const list = menu.querySelector<HTMLElement>(":scope > [data-menu-panel] [data-menu-list]");
  if (list) return controls(list)[0] ?? null;
  return menu.querySelector<HTMLElement>(":scope > [data-menu-panel] a[href], :scope > [data-menu-panel] summary");
}

function openAndEnter(menu: HTMLDetailsElement): void {
  setMenuOpen(menu, true);
  firstInside(menu)?.focus();
}

function moveWithin(list: Element, from: HTMLElement, key: string): boolean {
  const items = controls(list);
  const row = from.closest("li");
  const index = items.findIndex((control) => control.closest("li") === row);
  if (index < 0 || items.length === 0) return false;
  const last = items.length - 1;
  const next =
    key === "Home" ? 0 : key === "End" ? last : key === "ArrowDown" || key === "ArrowRight"
      ? (index + 1) % items.length
      : (index - 1 + items.length) % items.length;
  items[next]!.focus();
  return true;
}

export function handleMenuKey(event: KeyboardEvent): void {
  const target = event.target as HTMLElement | null;
  if (!target || !target.closest("[data-menu-root]")) return;
  const key = event.key;

  if (key === "Escape") {
    // The innermost open menu around the focus (an open menu's own summary included).
    const menu = target.closest<HTMLDetailsElement>(`${MENU}[open]`);
    if (!menu) return;
    event.preventDefault();
    event.stopPropagation();
    closeMenu(menu);
    summaryOf(menu)?.focus();
    return;
  }

  const list = target.closest("[data-menu-list], [data-menu-bar]");
  if (!list) return;
  const bar = list.matches("[data-menu-bar]");
  const row = target.closest("li");
  const menu = row ? rowMenu(row) : null;

  if (bar) {
    if (key === "ArrowLeft" || key === "ArrowRight" || key === "Home" || key === "End") {
      if (moveWithin(list, target, key)) event.preventDefault();
    } else if ((key === "ArrowDown" || key === "ArrowUp") && menu) {
      event.preventDefault();
      openAndEnter(menu);
    }
    return;
  }

  if (key === "ArrowDown" || key === "ArrowUp" || key === "Home" || key === "End") {
    if (moveWithin(list, target, key)) event.preventDefault();
    return;
  }
  if (key === "ArrowRight" && menu) {
    event.preventDefault();
    openAndEnter(menu);
    return;
  }
  if (key === "ArrowLeft") {
    const owner = list.closest<HTMLDetailsElement>(MENU);
    if (!owner) return;
    event.preventDefault();
    closeMenu(owner);
    summaryOf(owner)?.focus();
  }
}

export function installNavMenus(doc: Document = document): void {
  const view = doc.defaultView as MenuWindow | null;
  if (!view || view.__scaliusNavMenus) return;
  view.__scaliusNavMenus = true;

  const timers = new Map<HTMLDetailsElement, number>();
  const clearTimer = (menu: HTMLDetailsElement) => {
    const timer = timers.get(menu);
    if (timer !== undefined) view.clearTimeout(timer);
    timers.delete(menu);
  };
  const later = (menu: HTMLDetailsElement, ms: number, run: () => void) => {
    clearTimer(menu);
    timers.set(menu, view.setTimeout(() => {
      timers.delete(menu);
      run();
    }, ms));
  };

  // `toggle` does not bubble: listen while capturing. Native opens (a click
  // or Enter on the summary) get the same one-open rule and flip.
  doc.addEventListener(
    "toggle",
    (event) => {
      const menu = event.target as Element | null;
      if (!isMenu(menu) || !menu.open) return;
      setMenuOpen(menu, true);
    },
    true,
  );

  doc.addEventListener("click", (event) => {
    const summary = (event.target as Element | null)?.closest("summary");
    const menu = summary?.parentElement ?? null;
    if (!isMenu(menu)) return;
    clearTimer(menu);
    if (menu.open && menu.dataset.hoverOpen !== undefined) {
      // Hover already opened it: the click keeps it open until dismissed.
      event.preventDefault();
      delete menu.dataset.hoverOpen;
    }
  });

  // Capturing, so a drill level closes before the drawer sees Escape.
  doc.addEventListener("keydown", handleMenuKey, true);

  doc.addEventListener("pointerdown", (event) => {
    const target = event.target as Node | null;
    for (const menu of Array.from(doc.querySelectorAll<HTMLDetailsElement>('details[data-menu="popup"][open]'))) {
      const root = rootOf(menu) ?? menu;
      if (!target || !root.contains(target)) closeMenu(menu);
    }
  });

  doc.addEventListener("focusout", (event) => {
    const next = event.relatedTarget as Node | null;
    const root = (event.target as Element | null)?.closest("[data-menu-root]");
    if (!root || !next || root.contains(next)) return;
    for (const menu of openMenus(root)) if (menu.matches('[data-menu="popup"]')) closeMenu(menu);
  });

  doc.addEventListener("pointerover", (event) => {
    if ((event as PointerEvent).pointerType !== "mouse") return;
    const menu = (event.target as Element | null)?.closest<HTMLDetailsElement>("details[data-menu-hover]");
    if (!menu) return;
    clearTimer(menu);
    if (menu.open) return;
    const root = rootOf(menu);
    const switching = root ? openMenus(root).some((other) => !other.contains(menu)) : false;
    later(menu, switching ? 0 : HOVER_OPEN_MS, () => {
      setMenuOpen(menu, true);
      menu.dataset.hoverOpen = "";
    });
  });

  doc.addEventListener("pointerout", (event) => {
    if ((event as PointerEvent).pointerType !== "mouse") return;
    const menu = (event.target as Element | null)?.closest<HTMLDetailsElement>("details[data-menu-hover]");
    const next = event.relatedTarget as Node | null;
    if (!menu || (next && menu.contains(next))) return;
    if (!menu.open) clearTimer(menu);
    else if (menu.dataset.hoverOpen !== undefined) later(menu, HOVER_CLOSE_MS, () => closeMenu(menu));
  });

  const closeAll = () => {
    for (const menu of Array.from(doc.querySelectorAll<HTMLDetailsElement>('details[data-menu="popup"][open]'))) {
      // The departments rail open on the home page stays as rendered.
      if (menu.dataset.menuHomeOpen === undefined) closeMenu(menu);
    }
  };
  view.addEventListener("resize", () => {
    for (const menu of Array.from(doc.querySelectorAll<HTMLDetailsElement>(`${MENU}[open]`))) flipIfNeeded(menu);
  });
  doc.addEventListener("astro:before-swap", closeAll);
}
