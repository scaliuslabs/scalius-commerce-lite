/**
 * The tab bar's Categories tab under an app header skin: it opens the
 * header's own menu drawer (the element marked `data-menu-drawer`, a
 * `popover` or a `<dialog>`) instead of following its link to /categories,
 * and reports the drawer's state in `aria-expanded`. Without the script, or
 * without a marked drawer, the link opens the categories page.
 */
export function bindAppMenuTab(doc: Document): void {
  const tab = doc.querySelector<HTMLAnchorElement>("[data-app-menu-open]");
  const drawer = doc.querySelector<HTMLElement>("[data-menu-drawer]");
  if (!tab || !drawer) return;
  if (drawer.id) tab.setAttribute("aria-controls", drawer.id);
  const isOpen = () => (drawer instanceof HTMLDialogElement ? drawer.open : safeMatches(drawer, ":popover-open"));
  // A light-dismiss popover closes on the press itself: remember whether it was open.
  let wasOpen = false;
  tab.addEventListener("pointerdown", () => { wasOpen = isOpen(); });
  tab.addEventListener("click", (event) => {
    event.preventDefault();
    const open = event.detail === 0 ? isOpen() : wasOpen || isOpen();
    wasOpen = false;
    if (drawer instanceof HTMLDialogElement) {
      if (open) drawer.close();
      else drawer.showModal();
    } else if (drawer.hasAttribute("popover") && typeof drawer.showPopover === "function") {
      if (open) drawer.hidePopover();
      else drawer.showPopover();
    }
    sync();
  });
  const sync = () => tab.setAttribute("aria-expanded", String(isOpen()));
  drawer.addEventListener("toggle", sync);
  drawer.addEventListener("close", sync);
}

function safeMatches(element: Element, selector: string): boolean {
  try {
    return element.matches(selector);
  } catch {
    return false;
  }
}
