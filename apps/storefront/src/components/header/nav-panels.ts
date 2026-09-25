/**
 * Menu panels filled on intent. The header's HTML carries every department
 * and as many of their links as the theme's link budget allows
 * (nav-tree.ts `planHeaderNavigation`); a menu whose panels were cut names a
 * URL (`[data-nav-panels]`) that serves each department's panel whole (up to
 * `NAVIGATION_PANEL_CAPS`). The first hover, focus or touch on that menu
 * fetches it once and swaps each closed panel's contents for the full ones
 * (`template[data-panel-for="<key>"]`, matched to a row by `data-nav-key`),
 * rendered by the same components, so the page's markup and styles apply
 * unchanged. Without JavaScript, or until it arrives, the cut panels work as
 * they are and every department page lists the rest.
 */

type PanelsWindow = Window & { __scaliusNavPanels?: boolean };

const TARGET = ":scope > .desktop-nav-dropdown, :scope > .mega-panel, :scope > details > [data-menu-panel]";
const requested = new WeakSet<Element>();

/** Swaps each matching panel's contents for the fuller one in `html`; returns how many were filled. */
export function applyNavPanels(nav: Element, html: string): number {
  const doc = nav.ownerDocument;
  const holder = doc.createElement("template");
  holder.innerHTML = html;
  const rows = new Map<string, Element>();
  nav.querySelectorAll<HTMLElement>("[data-nav-key]").forEach((row) => rows.set(row.dataset.navKey ?? "", row));
  let filled = 0;
  holder.content.querySelectorAll<HTMLTemplateElement>("template[data-panel-for]").forEach((template) => {
    const row = rows.get(template.dataset.panelFor ?? "");
    const target = row?.querySelector<HTMLElement>(TARGET);
    const fresh = template.content.firstElementChild;
    // A panel the buyer is inside keeps its links (and the focus on them).
    if (!target || !fresh || (doc.activeElement && target.contains(doc.activeElement))) return;
    target.replaceChildren(...Array.from(fresh.childNodes));
    filled += 1;
  });
  nav.setAttribute("data-nav-panels-filled", "");
  return filled;
}

async function fill(nav: HTMLElement): Promise<void> {
  const src = nav.dataset.navPanels;
  if (!src) return;
  try {
    const response = await fetch(src, { credentials: "same-origin", headers: { Accept: "text/html" } });
    if (!response.ok) return;
    applyNavPanels(nav, await response.text());
  } catch {
    // The cut panels stay; their departments' pages list the rest.
  }
}

export function installNavPanels(doc: Document = document): void {
  const view = doc.defaultView as PanelsWindow | null;
  if (!view || view.__scaliusNavPanels) return;
  view.__scaliusNavPanels = true;
  const intent = (event: Event) => {
    const nav = (event.target as Element | null)?.closest?.<HTMLElement>("[data-nav-panels]");
    if (!nav || requested.has(nav)) return;
    requested.add(nav);
    void fill(nav);
  };
  doc.addEventListener("pointerover", intent, { passive: true });
  doc.addEventListener("focusin", intent);
  doc.addEventListener("touchstart", intent, { passive: true });
}
