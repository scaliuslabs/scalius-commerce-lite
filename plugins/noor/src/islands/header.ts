// The header's behaviour: marks the shell once the page scrolls
// (`data-scrolled`: the overlay header turns solid, the sticky one gains its
// shadow) and turns the announcements every five seconds, pausing on hover
// and focus, never for buyers who ask for less motion. It also makes the
// phone drawer (a native popover) modal: focus moves in on open, Tab stays
// inside it, and on close focus returns to the control that opened it.

import { defineIsland } from "@scalius/plugin-sdk/island";

const TURN_MS = 5000;
const FOCUSABLE = "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex='-1'])";

/** The drawer's reachable controls: a closed `<details>` hides everything but its summary. */
function focusables(drawer: HTMLElement): HTMLElement[] {
  return [...drawer.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((node) => {
    let scope: Element | null | undefined = node.tagName === "SUMMARY"
      ? node.parentElement?.parentElement?.closest("details")
      : node.parentElement?.closest("details");
    while (scope) {
      if (!(scope as HTMLDetailsElement).open) return false;
      scope = scope.parentElement?.closest("details");
    }
    return true;
  });
}

/** The drawer behaves as a modal dialog (Dawn's menu drawer): focus in, trapped, and returned. */
function modalDrawer(drawer: HTMLElement): () => void {
  let opener: HTMLElement | null = null;
  const onBeforeToggle = (event: Event) => {
    if ((event as ToggleEvent).newState !== "open") return;
    const active = document.activeElement;
    opener = active instanceof HTMLElement && active !== document.body && !drawer.contains(active) ? active : null;
  };
  const onToggle = (event: Event) => {
    if ((event as ToggleEvent).newState === "open") {
      focusables(drawer)[0]?.focus();
      return;
    }
    const target = opener;
    opener = null;
    const active = document.activeElement;
    if (target?.isConnected && (!active || active === document.body || drawer.contains(active))) target.focus();
  };
  const onKeydown = (event: KeyboardEvent) => {
    if (event.key !== "Tab") return;
    const nodes = focusables(drawer);
    if (nodes.length === 0) return;
    const first = nodes[0]!;
    const last = nodes[nodes.length - 1]!;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !drawer.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !drawer.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  };
  drawer.addEventListener("beforetoggle", onBeforeToggle);
  drawer.addEventListener("toggle", onToggle);
  drawer.addEventListener("keydown", onKeydown);
  return () => {
    drawer.removeEventListener("beforetoggle", onBeforeToggle);
    drawer.removeEventListener("toggle", onToggle);
    drawer.removeEventListener("keydown", onKeydown);
  };
}

export default defineIsland((element) => {
  const shell = element.closest<HTMLElement>(".noor-header-shell");
  if (!shell) return;
  let frame = 0;
  const update = () => {
    frame = 0;
    shell.toggleAttribute("data-scrolled", window.scrollY > 8);
  };
  const onScroll = () => {
    if (!frame) frame = requestAnimationFrame(update);
  };
  update();
  window.addEventListener("scroll", onScroll, { passive: true });
  const drawer = shell.querySelector<HTMLElement>("#noor-drawer");
  const releaseDrawer = drawer ? modalDrawer(drawer) : undefined;

  const items = [...element.querySelectorAll<HTMLElement>("[data-announce-list] > li")];
  let timer: ReturnType<typeof setInterval> | undefined;
  let paused = false;
  const list = items[0]?.parentElement;
  const pause = () => { paused = true; };
  const resume = () => { paused = false; };
  if (items.length > 1 && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    let current = 0;
    timer = setInterval(() => {
      if (paused || document.visibilityState !== "visible") return;
      items[current]!.removeAttribute("data-active");
      items[current]!.setAttribute("aria-hidden", "true");
      items[current]!.inert = true;
      current = (current + 1) % items.length;
      items[current]!.setAttribute("data-active", "");
      items[current]!.removeAttribute("aria-hidden");
      items[current]!.inert = false;
    }, TURN_MS);
    list?.addEventListener("pointerenter", pause);
    list?.addEventListener("pointerleave", resume);
    list?.addEventListener("focusin", pause);
    list?.addEventListener("focusout", resume);
  }
  return () => {
    releaseDrawer?.();
    window.removeEventListener("scroll", onScroll);
    if (frame) cancelAnimationFrame(frame);
    if (timer) clearInterval(timer);
    list?.removeEventListener("pointerenter", pause);
    list?.removeEventListener("pointerleave", resume);
    list?.removeEventListener("focusin", pause);
    list?.removeEventListener("focusout", resume);
  };
});
