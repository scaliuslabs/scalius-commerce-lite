// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StorefrontIslandContext, StorefrontIslandModule } from "@scalius/shared/plugins/storefront-protocol";
import { createIslandElement, installAppComponents } from "./app-components";

const cart = vi.hoisted(() => ({ subscribe: vi.fn(), hydrate: vi.fn(), quickAdd: vi.fn() }));
vi.mock("@/store/cart", () => ({ cartStore: { subscribe: cart.subscribe }, hydrateCartFromStorage: cart.hydrate }));
vi.mock("@/components/cards/scripts/quick-add-card", () => ({ initQuickAddCards: cart.quickAdd }));

let tag = 0;
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};
const moduleFor = (mount: StorefrontIslandModule["mount"]) => ({ default: { abi: 1 as const, mount } });
function element(load: Parameters<typeof createIslandElement>[0], hydrate = "load") {
  const name = `test-scalius-island-${++tag}`;
  customElements.define(name, createIslandElement(load));
  const host = document.createElement("div");
  host.dataset.sxApp = "acme.theme";
  host.dataset.sxBase = "/_x/acme.theme/release/";
  const island = document.createElement(name);
  island.dataset.island = "header";
  island.dataset.hydrate = hydrate;
  host.append(island);
  document.body.append(host);
  return { host, island };
}

beforeEach(() => {
  vi.clearAllMocks();
  cart.subscribe.mockImplementation((listener) => {
    listener({ totalItems: 2, totalAmount: 100 });
    return vi.fn();
  });
});
afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("app island connection lifecycle", () => {
  it("ignores an old import after removal and mounts the reconnect exactly once", async () => {
    const first = deferred<ReturnType<typeof moduleFor>>();
    const next = deferred<ReturnType<typeof moduleFor>>();
    const cleanup = vi.fn();
    const mount = vi.fn(() => cleanup);
    const load = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(next.promise);
    const { island, host } = element(load);
    island.remove();
    host.append(island);
    expect(load).toHaveBeenCalledTimes(2);
    first.resolve(moduleFor(mount));
    await first.promise;
    expect(mount).not.toHaveBeenCalled();
    next.resolve(moduleFor(mount));
    await next.promise;
    expect(mount).toHaveBeenCalledTimes(1);
    expect(island.hasAttribute("data-mounted")).toBe(true);
    island.remove();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(island.hasAttribute("data-mounted")).toBe(false);
  });

  it("cancels idle callbacks and ignores an already queued callback from a removed connection", () => {
    let run!: IdleRequestCallback;
    vi.stubGlobal("requestIdleCallback", vi.fn((callback: IdleRequestCallback) => { run = callback; return 7; }));
    const cancel = vi.fn();
    vi.stubGlobal("cancelIdleCallback", cancel);
    const load = vi.fn();
    const { island } = element(load, "idle");
    island.remove();
    expect(cancel).toHaveBeenCalledWith(7);
    run({ didTimeout: false, timeRemaining: () => 0 });
    expect(load).not.toHaveBeenCalled();
  });

  it("cancels the idle timeout fallback", () => {
    vi.useFakeTimers();
    vi.stubGlobal("requestIdleCallback", undefined);
    const load = vi.fn();
    const { island } = element(load, "idle");
    island.remove();
    vi.advanceTimersByTime(300);
    expect(load).not.toHaveBeenCalled();
  });

  it("removes interaction triggers while detached and starts only once on reconnect", async () => {
    const mount = vi.fn();
    const load = vi.fn(async () => moduleFor(mount));
    const { island, host } = element(load, "interaction");
    island.remove();
    island.dispatchEvent(new Event("pointerenter"));
    expect(load).not.toHaveBeenCalled();
    host.append(island);
    island.dispatchEvent(new Event("pointerenter"));
    island.dispatchEvent(new Event("focusin"));
    await vi.waitFor(() => expect(mount).toHaveBeenCalledTimes(1));
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("disconnects visibility observers and ignores their stale queued entries", async () => {
    const observers: Array<{ callback: IntersectionObserverCallback; disconnect: ReturnType<typeof vi.fn> }> = [];
    vi.stubGlobal("IntersectionObserver", class {
      disconnect = vi.fn();
      observe = vi.fn();
      constructor(callback: IntersectionObserverCallback) { observers.push({ callback, disconnect: this.disconnect }); }
    });
    const mount = vi.fn();
    const load = vi.fn(async () => moduleFor(mount));
    const { island, host } = element(load, "visible");
    island.remove();
    expect(observers[0]!.disconnect).toHaveBeenCalledTimes(1);
    host.append(island);
    const visible = [{ isIntersecting: true }] as IntersectionObserverEntry[];
    observers[0]!.callback(visible, {} as IntersectionObserver);
    expect(load).not.toHaveBeenCalled();
    observers[1]!.callback(visible, {} as IntersectionObserver);
    await vi.waitFor(() => expect(mount).toHaveBeenCalledTimes(1));
    expect(observers[1]!.disconnect).toHaveBeenCalledTimes(1);
  });

  it("ends cart subscriptions and returned event cleanups on each removal, even if the app omits unsubscribe", async () => {
    const stop = vi.fn();
    cart.subscribe.mockImplementation((listener) => {
      listener({ totalItems: 2, totalAmount: 100 });
      return stop;
    });
    const receive = vi.fn();
    const click = vi.fn();
    let lastContext!: StorefrontIslandContext;
    const mount: StorefrontIslandModule["mount"] = (island, _props, context) => {
      lastContext = context;
      context.onCart(receive);
      island.addEventListener("click", click);
      return () => island.removeEventListener("click", click);
    };
    const { island, host } = element(async () => moduleFor(mount));
    await vi.waitFor(() => expect(receive).toHaveBeenCalledTimes(1));
    island.click();
    expect(click).toHaveBeenCalledTimes(1);
    island.remove();
    expect(stop).toHaveBeenCalledTimes(1);
    island.click();
    expect(click).toHaveBeenCalledTimes(1);
    lastContext.onCart(receive);
    host.append(island);
    await vi.waitFor(() => expect(receive).toHaveBeenCalledTimes(2));
    expect(cart.subscribe).toHaveBeenCalledTimes(2);
    island.click();
    expect(click).toHaveBeenCalledTimes(2);
    island.remove();
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it("unsubscribes when the cart's synchronous first notification removes the island", async () => {
    const stop = vi.fn();
    cart.subscribe.mockImplementation((listener) => {
      listener({ totalItems: 2, totalAmount: 100 });
      return stop;
    });
    element(async () => moduleFor((island, _props, context) => {
      context.onCart(() => island.remove());
    }));
    await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
  });

  it("releases the handle even when a cart listener throws during subscribe's first notification", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stop = vi.fn();
    let notify!: (state: { totalItems: number; totalAmount: number }) => void;
    cart.subscribe.mockImplementation((listener) => {
      notify = listener;
      listener({ totalItems: 2, totalAmount: 100 });
      return stop;
    });
    const receive = vi.fn(() => { throw new Error("app cart listener failed"); });
    element(async () => moduleFor((_island, _props, context) => { context.onCart(receive); }));
    await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
    expect(warn).toHaveBeenCalledTimes(1);
    // A queued notification and later disconnect must not revive the callback
    // or try to stop the same subscription a second time.
    notify({ totalItems: 3, totalAmount: 200 });
    document.body.replaceChildren();
    expect(receive).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("cancels a subscription requested by a mount that throws before the cart import resolves", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let failedContext!: StorefrontIslandContext;
    const mount = vi.fn((_element: HTMLElement, _props: unknown, context: StorefrontIslandContext) => {
      failedContext = context;
      context.onCart(vi.fn());
      throw new Error("app mount failed");
    });
    element(async () => moduleFor(mount));
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    failedContext.onCart(vi.fn());
    await vi.dynamicImportSettled();
    expect(cart.subscribe).not.toHaveBeenCalled();
  });

  it("runs a returned cleanup when the app removes its element during mount", async () => {
    const cleanup = vi.fn();
    const { island } = element(async () => moduleFor((node) => { node.remove(); return cleanup; }));
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledTimes(1));
    expect(island.hasAttribute("data-mounted")).toBe(false);
  });
});

describe("app component host installation", () => {
  it("does not duplicate the shared cart subscription or cart opener on repeat install", async () => {
    document.body.innerHTML = '<div data-sx-app="acme.theme"><button data-cart-open>Cart</button><span data-scalius-cart-count></span></div>';
    installAppComponents();
    installAppComponents();
    await vi.waitFor(() => expect(cart.subscribe).toHaveBeenCalledTimes(1));
    expect(cart.quickAdd).toHaveBeenCalledTimes(1);
    expect(document.querySelector("[data-scalius-cart-count]")?.textContent).toBe("2");
    const events = vi.fn();
    document.addEventListener("open-cart", events);
    try {
      document.querySelector("button")!.click();
      expect(events).toHaveBeenCalledTimes(1);
      expect(events).toHaveBeenCalledWith(expect.objectContaining({ type: "open-cart" }));
    } finally {
      document.removeEventListener("open-cart", events);
    }
  });
});
