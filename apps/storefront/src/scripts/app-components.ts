// The browser side of app components (packages/plugin-sdk/docs/storefront.md), loaded
// once on pages that show one. It gives app markup the store's own
// behaviours with no app JavaScript, and mounts declared islands:
//
// - `a[data-card-quick-add]`: adds a simple product in place and opens the
//   cart (the core card's quick add);
// - `[data-cart-open]`: opens the cart drawer;
// - `[data-scalius-cart-count]`: the cart's item count, kept current;
// - `<scalius-island data-island data-hydrate data-props>`: loads the app's
//   island module from its release's files when its moment comes (visible,
//   idle, load or first interaction) and mounts it on the element;
// - `<scalius-deferred data-hydrate><template>`: moves the template's
//   content into the page at its moment, where its islands then mount;
// - `[data-scalius-when="signed-in" | "signed-out"]`: `<html
//   data-scalius-signed-in>` follows the sign-in hint, global.css hides the
//   other version.

import type { StorefrontIslandContext, StorefrontIslandModule, StorefrontMoney } from "@scalius/shared/plugins/storefront-protocol";
import { toMinor } from "@scalius/shared/money";
import { formatMinorMoney, getCurrencyCode, getDecimalPlaces } from "@/lib/currency";
import { productContext } from "./product-context";
import { initQuickAddCards } from "@/components/cards/scripts/quick-add-card";

type CartSummary = { count: number; total: StorefrontMoney };

/** The cart's total (decimal page-currency units in the cart store) as protocol money. */
function cartTotal(total: number): StorefrontMoney {
  const currency = getCurrencyCode();
  const money = { amountMinor: toMinor(Math.max(0, total), getDecimalPlaces(currency)), currency };
  return { ...money, formatted: formatMinorMoney(money) };
}

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
      try { listener({ count: state.totalItems, total: cartTotal(state.totalAmount) }); }
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

/** An island's `addLine`: the buyer UI's add-line flow, for this app (its own purchase options only). */
function addLineFor(pluginId: string): NonNullable<StorefrontIslandContext["addLine"]> {
  return async (line) => {
    try {
      const { addVariantLine } = await import("@/lib/buyer-ui/actions");
      const addedLineKey = await addVariantLine({
        variantId: typeof line?.variantId === "string" ? line.variantId : "",
        quantity: line?.quantity ?? 1,
        ...(typeof line?.purchaseOption === "string" ? { purchaseOption: line.purchaseOption } : {}),
      }, pluginId);
      document.dispatchEvent(new CustomEvent("open-cart", { detail: { addedLineKey } }));
      return true;
    } catch {
      return false;
    }
  };
}

function contextFor(element: Element): StorefrontIslandContext | null {
  const host = element.closest<HTMLElement>("[data-sx-app][data-sx-base]");
  const pluginId = host?.dataset.sxApp;
  const assets = host?.dataset.sxBase;
  if (!pluginId || !assets || !/^\/_x\//.test(assets)) return null;
  const product = productContext();
  return {
    pluginId,
    assets,
    language: document.documentElement.lang || "en",
    currency: getCurrencyCode(),
    // The store's buyer format (the page's symbol for the page's currency).
    formatMoney: (money) => formatMinorMoney(money),
    openCart,
    quickAdd,
    addLine: addLineFor(pluginId),
    onCart,
    fetchApp: (path, init) => fetch(`/apps/${pluginId}/${path.replace(/^\/+/, "")}`, { credentials: "same-origin", ...init }),
    signedIn: signedInHint,
    ...(product ? { product } : {}),
  };
}

/**
 * Calls `start` once at the element's moment (`load`: now; `idle`; the first
 * `interaction` within `interactive`; otherwise when it comes within `margin`
 * of the viewport) and returns what cancels it before then.
 */
function atMoment(element: HTMLElement, hydrate: string, margin: string, start: () => void, interactive: HTMLElement = element): (() => void) | undefined {
  if (hydrate === "load") {
    start();
    return undefined;
  }
  if (hydrate === "idle") {
    if (window.requestIdleCallback) {
      const id = window.requestIdleCallback(start, { timeout: 2000 });
      return () => window.cancelIdleCallback?.(id);
    }
    const id = window.setTimeout(start, 200);
    return () => window.clearTimeout(id);
  }
  if (hydrate === "interaction") {
    const events = ["pointerenter", "focusin", "touchstart"] as const;
    for (const name of events) interactive.addEventListener(name, start, { once: true, passive: true });
    return () => {
      for (const name of events) interactive.removeEventListener(name, start);
    };
  }
  if (typeof IntersectionObserver === "undefined") {
    start();
    return undefined;
  }
  const observer = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) start();
  }, { rootMargin: margin });
  observer.observe(element);
  return () => observer.disconnect();
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
      connection.cancelStart = atMoment(this, this.dataset.hydrate ?? "visible", "200px", () => void this.#mount(connection));
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
      const product = context.product;
      if (product) {
        context.product = {
          state: product.state,
          onChange: (listener) => {
            if (!this.#current(connection)) return () => {};
            const stop = product.onChange((state) => { if (this.#current(connection)) listener(state); });
            connection.cleanups.add(stop);
            return () => { if (connection.cleanups.delete(stop)) stop(); };
          },
        };
      }
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

/**
 * `<scalius-deferred data-hydrate><template>…</template></scalius-deferred>`:
 * at its moment the template's content replaces the template, moved (never
 * reparsed), so islands and deferred markup inside connect and schedule
 * themselves like any other; no observer watches the document.
 */
export function createDeferredElement(): CustomElementConstructor {
  return class ScaliusDeferred extends HTMLElement {
    #cancel: (() => void) | undefined;
    #waiting = false;

    connectedCallback(): void {
      if (this.#waiting || !this.#template()) return;
      this.#waiting = true;
      // Its own box holds nothing to focus: `interaction` is the first hover,
      // focus or tap in the element that holds it.
      this.#cancel = atMoment(this, this.dataset.hydrate ?? "visible", "600px", () => this.#reveal(), this.parentElement ?? this);
    }

    disconnectedCallback(): void {
      this.#stop();
    }

    #template(): HTMLTemplateElement | null {
      const first = this.firstElementChild;
      return first instanceof HTMLTemplateElement ? first : null;
    }

    #stop(): void {
      this.#waiting = false;
      const cancel = this.#cancel;
      this.#cancel = undefined;
      cancel?.();
    }

    #reveal(): void {
      if (!this.#waiting || !this.isConnected) return;
      this.#stop();
      const template = this.#template();
      if (!template) return;
      template.replaceWith(template.content);
      this.dataset.revealed = "";
    }
  };
}

/** The readable sign-in hint the store sets beside its httpOnly session cookie (a UI hint, never authority). */
function signedInHint(): boolean {
  try {
    return document.cookie.split(";").some((cookie) => cookie.trim() === "cs_auth=1");
  } catch {
    return false;
  }
}

/**
 * `<html data-scalius-signed-in>` while the hint says the buyer is signed in:
 * global.css then shows `[data-scalius-when="signed-in"]` parts instead of
 * `"signed-out"` ones. Kept current on sign-in, sign-out and back/forward.
 */
export function syncSignedInState(): void {
  document.documentElement.toggleAttribute("data-scalius-signed-in", signedInHint());
}

function installSignedInState(): void {
  syncSignedInState();
  for (const name of ["customer-login", "customer-logout", "pageshow"]) window.addEventListener(name, syncSignedInState);
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
  installSignedInState();
  if (!customElements.get("scalius-island")) customElements.define("scalius-island", createIslandElement());
  // STOREFRONT_DEFERRED_TAG, spelled out so the page bundle imports no protocol values.
  if (!customElements.get("scalius-deferred")) customElements.define("scalius-deferred", createDeferredElement());
}
