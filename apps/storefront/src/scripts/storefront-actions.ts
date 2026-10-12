// Shared, opt-in actions for core and app markup. Themes can keep custom
// popovers: only these attributes participate, and prevented events stay theirs.
import { pagePath } from "@/lib/presence-url";

let uninstall: (() => void) | undefined;

/** Release a theme's top layer before a core modal captures its return focus. */
function handOffPopover(target: Element | null): void {
  const popovers: HTMLElement[] = [];
  for (let popover = target?.closest<HTMLElement>("[popover]"); popover;
    popover = popover.parentElement?.closest<HTMLElement>("[popover]")) {
    if (typeof popover.hidePopover === "function" && popover.matches(":popover-open")) popovers.push(popover);
  }
  if (popovers.length === 0) return;
  for (const popover of popovers) {
    if (popover.isConnected && popover.matches(":popover-open")) popover.hidePopover();
  }
  // A control inside the now-closed drawer cannot receive restored focus.
  // Prefer its visible invoker; native hidePopover may already restore it.
  const outer = popovers.at(-1)!;
  if (!outer.id) return;
  const invoker = Array.from(document.querySelectorAll<HTMLElement>("[popovertarget]")).find((control) =>
    control.getAttribute("popovertarget") === outer.id && !outer.contains(control)
    && !control.hidden && !control.matches(":disabled")
    && getComputedStyle(control).visibility !== "hidden" && control.getClientRects().length > 0);
  invoker?.focus({ preventScroll: true });
}

/** Install once for the document; delegation also covers replaced app markup. */
export function installStorefrontActions(): () => void {
  if (uninstall) return uninstall;
  const targetOf = (event: Event) => event.target instanceof Element ? event.target : null;
  const modified = (event: MouseEvent) => event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
  const openSearch = (event: Event) => {
    event.preventDefault();
    handOffPopover(targetOf(event));
    document.dispatchEvent(new CustomEvent("open-search-palette"));
  };
  const click = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0 || modified(event)) return;
    const target = targetOf(event);
    if (target?.closest("#mobile-search-toggle, #scrolled-search-trigger, [data-search-open]")) {
      openSearch(event);
    } else if (target?.closest("#account-link, [data-account-link]")) {
      // This non-authoritative cookie is only a UI hint. Read it at the click,
      // so a login/logout in another tab doesn't leave a captured stale value.
      if (document.cookie.split(";").some((cookie) => cookie.trim() === "cs_auth=1")) return;
      event.preventDefault();
      handOffPopover(target);
      window.dispatchEvent(new CustomEvent("open-auth-modal"));
    }
  };
  const pointerdown = (event: PointerEvent) => {
    if (event.defaultPrevented || event.pointerType === "" || event.button !== 0 || modified(event)) return;
    // Pointer users open the palette; keyboard users can type and submit the
    // ordinary GET search form without JavaScript taking their field away.
    if (targetOf(event)?.closest("[data-search-inline]")) openSearch(event);
  };
  const submit = (event: SubmitEvent) => {
    if (event.defaultPrevented) return;
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !form.matches("[data-header-search]")) return;
    const scope = form.querySelector<HTMLSelectElement>("[data-search-scope]")?.value ?? "";
    if (!scope.startsWith("/categories/")) return;
    const target = new URL(scope, window.location.origin);
    const query = (form.querySelector<HTMLInputElement>("input[name='q']")?.value ?? "").trim();
    if (query) target.searchParams.set("q", query);
    event.preventDefault();
    window.location.assign(pagePath(target.pathname + target.search));
  };
  document.addEventListener("click", click);
  document.addEventListener("pointerdown", pointerdown);
  document.addEventListener("submit", submit);
  const remove = () => {
    if (uninstall !== remove) return;
    document.removeEventListener("click", click);
    document.removeEventListener("pointerdown", pointerdown);
    document.removeEventListener("submit", submit);
    uninstall = undefined;
  };
  uninstall = remove;
  return remove;
}
