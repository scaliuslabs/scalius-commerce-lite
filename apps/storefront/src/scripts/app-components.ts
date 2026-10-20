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
import { formatMoney, getCurrencyCode } from "@/lib/currency";
import { initQuickAddCards } from "@/components/cards/scripts/quick-add-card";

type CartSummary = { count: number; total: number };

async function cartStoreModule() {
  return import("@/store/cart");
}

function onCart(listener: (cart: CartSummary) => void): () => void {
  let unsubscribe: (() => void) | null = null;
  let stopped = false;
  const stopListening = () => {
    stopped = true;
    const stop = unsubscribe;
    unsubscribe = null;
    stop?.();
  };
  void cartStoreModule().then(({ cartStore, hydrateCartFromStorage }) => {
    if (stopped) return;
    hydrateCartFromStorage();
    const stop = cartStore.subscribe((state) => {
      if (stopped) return;
      try { listener({ count: state.totalItems, total: state.totalAmount }); }
      catch (error) {
        stopListening();
        console.warn("App cart listener failed", error);
      }
    });
    // The first notification can remove the island or fail before subscribe
    // returns its cleanup. Stop it as soon as the handle exists.
    if (stopped) stop();
    else unsubscribe = stop;
  });
  return stopListening;
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
    language: document.documentElement.lang || "en",
    currency: getCurrencyCode(),
    // The page's currency and symbol, as the store writes prices.
    formatMoney: (amount) => formatMoney(amount),
    openCart,
    quickAdd,
    onCart,
    fetchApp: (path, init) => fetch(`/apps/${pluginId}/${path.replace(/^\/+/, "")}`, { credentials: "same-origin", ...init }),
  };
}

const ISLAND_NAME = /^[a-z][a-z0-9_-]{0,47}$/;

type IslandModule = { default?: StorefrontIslandModule };
type IslandConnection = {
  started: boolean;
  cancelStart?: () => void;
  cleanups: Set<() => void>;
};

/** A fresh element class also lets lifecycle tests control an in-flight import. */
export function createIslandElement(
  loadModule: (url: string) => Promise<IslandModule> = (url) => import(/* @vite-ignore */ url),
): CustomElementConstructor {
  return class ScaliusIsland extends HTMLElement {
    #connection: IslandConnection | null = null;

    connectedCallback(): void {
      if (this.#connection) return;
      const connection: IslandConnection = { started: false, cleanups: new Set() };
      this.#connection = connection;
      const hydrate = this.dataset.hydrate ?? "visible";
      const start = () => void this.#mount(connection);
      if (hydrate === "load") return start();
      if (hydrate === "idle") {
        if (window.requestIdleCallback) {
          const id = window.requestIdleCallback(start, { timeout: 2000 });
          connection.cancelStart = () => window.cancelIdleCallback?.(id);
        } else {
          const id = window.setTimeout(start, 200);
          connection.cancelStart = () => window.clearTimeout(id);
        }
        return;
      }
      if (hydrate === "interaction") {
        const events = ["pointerenter", "focusin", "touchstart"] as const;
        for (const name of events) this.addEventListener(name, start, { once: true, passive: true });
        connection.cancelStart = () => {
          for (const name of events) this.removeEventListener(name, start);
        };
        return;
      }
      if (typeof IntersectionObserver === "undefined") return start();
      const observer = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) start();
      }, { rootMargin: "200px" });
      connection.cancelStart = () => observer.disconnect();
      observer.observe(this);
    }

    disconnectedCallback(): void {
      const connection = this.#connection;
      this.#connection = null;
      delete this.dataset.mounted;
      if (connection) this.#dispose(connection);
    }

    #current(connection: IslandConnection): boolean {
      return this.isConnected && this.#connection === connection;
    }

    #dispose(connection: IslandConnection): void {
      connection.cancelStart?.();
      connection.cancelStart = undefined;
      for (const cleanup of connection.cleanups) {
        connection.cleanups.delete(cleanup);
        try { cleanup(); } catch (error) { console.warn("Island cleanup failed", error); }
      }
    }

    async #mount(connection: IslandConnection): Promise<void> {
      if (!this.#current(connection) || connection.started) return;
      connection.started = true;
      connection.cancelStart?.();
      connection.cancelStart = undefined;
      const name = this.dataset.island ?? "";
      const context = contextFor(this);
      if (!ISLAND_NAME.test(name) || !context) return;
      // Host-owned subscriptions end even when an island omits its cleanup or
      // throws partway through mounting. A late callback cannot revive them.
      context.onCart = (listener) => {
        if (!this.#current(connection)) return () => {};
        const stop = onCart((cart) => { if (this.#current(connection)) listener(cart); });
        connection.cleanups.add(stop);
        return () => { if (connection.cleanups.delete(stop)) stop(); };
      };
      let props: unknown;
      try { props = this.dataset.props ? JSON.parse(this.dataset.props) : undefined; }
      catch { props = undefined; }
      try {
        const module = await loadModule(`${context.assets}islands/${name}.js`);
        if (!this.#current(connection)) return;
        const island = module.default;
        if (!island || island.abi !== 1 || typeof island.mount !== "function") return;
        const cleanup = island.mount(this, props, context);
        if (!this.#current(connection)) {
          if (typeof cleanup === "function") cleanup();
          return;
        }
        if (typeof cleanup === "function") connection.cleanups.add(cleanup);
        this.dataset.mounted = "";
      } catch (error) {
        if (this.#connection === connection) this.#connection = null;
        this.#dispose(connection);
        console.warn(`[${context.pluginId}] island ${name} failed to mount`, error);
      }
    }
  };
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
  if (!customElements.get("scalius-island")) customElements.define("scalius-island", createIslandElement());
}
