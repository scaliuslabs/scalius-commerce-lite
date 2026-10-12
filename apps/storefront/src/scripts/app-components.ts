// The browser side of app components (docs/STOREFRONT-COMPONENTS.md), loaded
// once on pages that show one. It gives app markup the store's own
// behaviours with no app JavaScript, and mounts declared islands:
//
// - `a[data-card-quick-add]`: adds a simple product in place and opens the
//   cart (the core card's quick add);
// - `[data-cart-open]`: opens the cart drawer;
// - `[data-scalius-cart-count]`: the cart's item count, kept current;
// - `<scalius-island data-island data-hydrate data-props>`: loads the app's
//   island module from its release's files when its moment comes (visible,
//   idle, load or first interaction) and mounts it on the element.

import type { StorefrontIslandContext, StorefrontIslandModule } from "@scalius/shared/plugins/storefront-protocol";
import { DEFAULT_CURRENCY, formatMoney } from "@scalius/shared/currency";
import { initQuickAddCards } from "@/components/cards/scripts/quick-add-card";

type CartSummary = { count: number; total: number };

async function cartStoreModule() {
  return import("@/store/cart");
}

function onCart(listener: (cart: CartSummary) => void): () => void {
  let unsubscribe: (() => void) | null = null;
  let stopped = false;
  void cartStoreModule().then(({ cartStore, hydrateCartFromStorage }) => {
    if (stopped) return;
    hydrateCartFromStorage();
    unsubscribe = cartStore.subscribe((state) => listener({ count: state.totalItems, total: state.totalAmount }));
  });
  return () => {
    stopped = true;
    unsubscribe?.();
  };
}

function money(amount: number): string {
  return formatMoney(amount, {
    symbol: window.__CURRENCY_SYMBOL__ || DEFAULT_CURRENCY.symbol,
    code: window.__CURRENCY_CODE__ || DEFAULT_CURRENCY.code,
  });
}

function openCart(): void {
  document.dispatchEvent(new CustomEvent("open-cart"));
}

/**
 * A quick add from an island: the core card's flow, through a detached link
 * (a same-store product URL as the card data names it, presence prefix included).
 */
async function quickAdd(productUrl: string): Promise<boolean> {
  const url = new URL(productUrl, location.origin);
  if (url.origin !== location.origin) return false;
  const link = document.createElement("a");
  link.href = url.href;
  link.dataset.cardQuickAdd = "";
  link.hidden = true;
  document.body.appendChild(link);
  try {
    link.click();
    return true;
  } finally {
    link.remove();
  }
}

function contextFor(element: Element): StorefrontIslandContext | null {
  const host = element.closest<HTMLElement>("[data-sx-app][data-sx-base]");
  const pluginId = host?.dataset.sxApp;
  const assets = host?.dataset.sxBase;
  if (!pluginId || !assets || !/^\/_x\//.test(assets)) return null;
  return {
    pluginId,
    assets,
    language: document.documentElement.lang.startsWith("bn") ? "bn" : "en",
    currency: window.__CURRENCY_CODE__ || DEFAULT_CURRENCY.code,
    formatMoney: money,
    openCart,
    quickAdd,
    onCart,
    fetchApp: (path, init) => fetch(`/apps/${pluginId}/${path.replace(/^\/+/, "")}`, { credentials: "same-origin", ...init }),
  };
}

const ISLAND_NAME = /^[a-z][a-z0-9-]{0,47}$/;

class ScaliusIsland extends HTMLElement {
  #cleanup: (() => void) | null = null;
  #mounted = false;
  #observer: IntersectionObserver | null = null;
  #triggers: Array<() => void> = [];

  connectedCallback(): void {
    const hydrate = this.dataset.hydrate ?? "visible";
    const start = () => void this.#mount();
    if (hydrate === "load") return start();
    if (hydrate === "idle") {
      const idle = (window as { requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number }).requestIdleCallback;
      if (idle) idle(start, { timeout: 2000 });
      else setTimeout(start, 200);
      return;
    }
    if (hydrate === "interaction") {
      const events = ["pointerenter", "focusin", "touchstart"] as const;
      const once = () => {
        this.#triggers.forEach((remove) => remove());
        this.#triggers = [];
        start();
      };
      for (const name of events) {
        this.addEventListener(name, once, { once: true, passive: true });
        this.#triggers.push(() => this.removeEventListener(name, once));
      }
      return;
    }
    this.#observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        this.#observer?.disconnect();
        this.#observer = null;
        start();
      }
    }, { rootMargin: "200px" });
    this.#observer.observe(this);
  }

  disconnectedCallback(): void {
    this.#observer?.disconnect();
    this.#triggers.forEach((remove) => remove());
    this.#cleanup?.();
    this.#cleanup = null;
  }

  async #mount(): Promise<void> {
    if (this.#mounted) return;
    this.#mounted = true;
    const name = this.dataset.island ?? "";
    const context = contextFor(this);
    if (!ISLAND_NAME.test(name) || !context) return;
    let props: unknown = undefined;
    try {
      props = this.dataset.props ? JSON.parse(this.dataset.props) : undefined;
    } catch {
      props = undefined;
    }
    try {
      const module = await import(/* @vite-ignore */ `${context.assets}islands/${name}.js`) as { default?: StorefrontIslandModule };
      const island = module.default;
      if (!island || island.abi !== 1 || typeof island.mount !== "function") return;
      const cleanup = island.mount(this, props, context);
      if (typeof cleanup === "function") this.#cleanup = cleanup;
      this.dataset.mounted = "";
    } catch (error) {
      console.warn(`[${context.pluginId}] island ${name} failed to mount`, error);
    }
  }
}

function installCartCount(): void {
  const counts = () => document.querySelectorAll<HTMLElement>("[data-scalius-cart-count]");
  if (counts().length === 0) return;
  onCart(({ count }) => {
    for (const element of counts()) {
      element.textContent = count > 0 ? String(count) : "";
      element.toggleAttribute("data-empty", count === 0);
    }
  });
}

function installCartOpeners(): void {
  document.addEventListener("click", (event) => {
    const opener = event.target instanceof Element ? event.target.closest("[data-sx-app] [data-cart-open]") : null;
    if (!opener || event.defaultPrevented || (event as MouseEvent).button !== 0) return;
    event.preventDefault();
    openCart();
  });
}

let installed = false;

export function installAppComponents(): void {
  if (installed) return;
  installed = true;
  initQuickAddCards();
  installCartOpeners();
  installCartCount();
  if (!customElements.get("scalius-island")) customElements.define("scalius-island", ScaliusIsland);
}
