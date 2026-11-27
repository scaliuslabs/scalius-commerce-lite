// The browser side of a theme's chrome on a buyer page
// (components/private/PrivateChrome.astro): the store's own behaviours for
// the inert markup inside its shadow roots, with no app code. The store's
// delegated actions read a press's real target through the shadow boundary
// (scripts/storefront-actions.ts: sign-in and search; lib/color-scheme.ts:
// the light or dark switch); this adds what app components get elsewhere:
//
// - `data-scalius-signed-in` on each shadow host, kept with the sign-in hint
//   (the inline script after a host sets it before first paint);
// - `[data-scalius-cart-count]` inside a shadow root: the cart's item count;
// - `[data-cart-open]` inside a shadow root, and the store's phone tab bar
//   under it: opens the cart drawer.
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

let installed = false;

export function installBuyerChrome(): void {
  if (installed) return;
  installed = true;
  syncSignedIn();
  for (const name of ["customer-login", "customer-logout", "pageshow"]) window.addEventListener(name, syncSignedIn);
  installCartCount();
  installCartOpeners();
}
