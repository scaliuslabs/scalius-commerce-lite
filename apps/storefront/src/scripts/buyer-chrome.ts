// The browser side of a theme's chrome on a buyer page
// (components/private/PrivateChrome.astro): the store's own behaviours for
// the inert markup inside its shadow roots, with no app code. The store's
// delegated actions read a press's real target through the shadow boundary
// (scripts/storefront-actions.ts: sign-in and search; lib/color-scheme.ts:
// the light or dark switch); this adds what app components get elsewhere:
//
// - `data-scalius-signed-in` on each shadow host, kept with the sign-in hint
//   (the server renders it from the session, so it holds with scripts off);
// - `[data-scalius-cart-count]` inside a shadow root: the cart's item count;
// - `[data-cart-open]` inside a shadow root, and the store's phone tab bar
//   under it: opens the cart drawer;
// - `[data-buyer-panel-open]` (the rebuild wrote it for a theme's button that
//   opened one of its popovers): opens the store's own panel for it
//   (`#buyer-panel-<region>-<index>`, a top-layer element the store alone
//   styles), a menu placed under the pressed button and held inside the
//   screen; `[data-buyer-panel-close]` inside a panel closes it. Without this
//   script the theme's buttons open nothing.
import { formatCount } from "@/lib/store-time-zone";
import { loadLazyScript } from "@/scripts/lazy-script";

/** The open shadow roots of the chrome the page draws. */
export function buyerChromeRoots(root: Document = document): ShadowRoot[] {
  return [...root.querySelectorAll("scalius-chrome")].flatMap((host) => (host.shadowRoot ? [host.shadowRoot] : []));
}

/** Whether a node is inside one of the chrome's shadow roots. */
function inChrome(node: Node): boolean {
  const root = node.getRootNode();
  return root instanceof ShadowRoot && root.host.localName === "scalius-chrome";
}

/** The readable sign-in hint the store sets beside its httpOnly session cookie (a UI hint, never authority). */
function signedInHint(): boolean {
  try {
    return document.cookie.split(";").some((cookie) => cookie.trim() === "cs_auth=1");
  } catch {
    return false;
  }
}

function syncSignedIn(): void {
  const signedIn = signedInHint();
  document.documentElement.toggleAttribute("data-scalius-signed-in", signedIn);
  for (const host of document.querySelectorAll("scalius-chrome")) host.toggleAttribute("data-scalius-signed-in", signedIn);
}

function installCartCount(): void {
  const counts = () => buyerChromeRoots().flatMap((root) => [...root.querySelectorAll<HTMLElement>("[data-scalius-cart-count]")]);
  if (counts().length === 0) return;
  void loadLazyScript(async () => {
    const { cartStore, hydrateCartFromStorage } = await import("@/store/cart");
    return { cartStore, hydrateCartFromStorage };
  }).then(({ cartStore, hydrateCartFromStorage }) => {
    hydrateCartFromStorage();
    cartStore.subscribe((state) => {
      for (const element of counts()) {
        element.textContent = state.totalItems > 0 ? formatCount(state.totalItems) : "";
        element.toggleAttribute("data-empty", state.totalItems === 0);
      }
    });
  }, (error: unknown) => console.warn("The cart did not load for the header", error));
}

function installCartOpeners(): void {
  document.addEventListener("click", (event) => {
    const target = event.composedPath()[0];
    const opener = target instanceof Element ? target.closest("[data-cart-open]") : null;
    if (!opener || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (!inChrome(opener) && !opener.closest('#mobile-tab-bar[data-tab-menu="app"]')) return;
    event.preventDefault();
    document.dispatchEvent(new CustomEvent("open-cart"));
  });
}

/** Places a menu panel under the button that opens it, inside the screen with a margin; a drawer is placed by the store's CSS. */
function placePanel(panel: HTMLElement, opener: Element): void {
  if (panel.dataset.buyerChromePanel !== "menu") return;
  const box = opener.getBoundingClientRect();
  const margin = 16;
  const width = Math.min(448, innerWidth - margin * 2);
  const top = Math.min(Math.max(margin, box.bottom + 4), Math.round(innerHeight * 0.5));
  const left = Math.min(Math.max(margin, box.left), innerWidth - width - margin);
  panel.style.setProperty("--buyer-panel-top", `${Math.round(top)}px`);
  panel.style.setProperty("--buyer-panel-left", `${Math.round(left)}px`);
}

function installPanels(): void {
  document.addEventListener("click", (event) => {
    const target = event.composedPath()[0];
    if (!(target instanceof Element) || !inChrome(target)) return;
    const host = (target.getRootNode() as ShadowRoot).host;
    const opener = target.closest("[data-buyer-panel-open]");
    if (opener) {
      const panel = document.getElementById(`buyer-panel-${host.getAttribute("data-chrome")}-${opener.getAttribute("data-buyer-panel-open")}`);
      if (!panel?.hasAttribute("data-buyer-chrome-panel") || typeof panel.showPopover !== "function") return;
      event.preventDefault();
      placePanel(panel, opener);
      if (!panel.matches(":popover-open")) panel.showPopover();
      opener.setAttribute("aria-expanded", "true");
      panel.addEventListener("toggle", () => opener.setAttribute("aria-expanded", String(panel.matches(":popover-open"))), { once: true });
      return;
    }
    if (target.closest("[data-buyer-panel-close]")) {
      const panel = host.closest<HTMLElement>("[data-buyer-chrome-panel]");
      if (panel?.matches(":popover-open")) panel.hidePopover();
    }
  });
}

let installed = false;

export function installBuyerChrome(): void {
  if (installed) return;
  installed = true;
  syncSignedIn();
  for (const name of ["customer-login", "customer-logout", "pageshow"]) window.addEventListener(name, syncSignedIn);
  installCartCount();
  installCartOpeners();
  installPanels();
}
