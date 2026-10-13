// @vitest-environment node

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const SOURCE = readFileSync(new URL("../../public/push-sw.js", import.meta.url), "utf8");
const ORIGIN = "https://shop.example";

type Listener = (event: Record<string, unknown>) => void;

/** Runs the worker file against a fake service worker scope and returns its listeners and calls. */
function load(scriptUrl = `${ORIGIN}/push-sw.js`) {
  const listeners = new Map<string, Listener>();
  const showNotification = vi.fn(async () => undefined);
  const openWindow = vi.fn(async () => null);
  const clients = { list: [] as Array<Record<string, unknown>> };
  const scope = {
    location: new URL(scriptUrl),
    addEventListener: (name: string, listener: Listener) => listeners.set(name, listener),
    skipWaiting: vi.fn(),
    registration: { showNotification, getNotifications: vi.fn(async () => []) },
    clients: {
      claim: vi.fn(async () => undefined),
      matchAll: vi.fn(async () => clients.list),
      openWindow,
    },
  };
  const fetchSession = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ success: true, data: { authenticated: true, customer: { customerId: "cust_A" } } })));
  new Function("self", "URL", "fetch", "AbortController", "setTimeout", "clearTimeout", SOURCE)(scope, URL, fetchSession, AbortController, setTimeout, clearTimeout);
  const wait = async (event: { promise?: Promise<unknown> }) => event.promise;
  return { listeners, showNotification, openWindow, clients, scope, wait, fetchSession };
}

function push(worker: ReturnType<typeof load>, payload: unknown, raw = false) {
  let promise: Promise<unknown> | undefined;
  worker.listeners.get("push")!({
    data: { json: () => (raw ? JSON.parse(String(payload)) : { recipient: { audience: "customer", id: "cust_A" }, notification: payload }) },
    waitUntil: (value: Promise<unknown>) => { promise = value; },
  });
  return promise;
}

function click(worker: ReturnType<typeof load>, url: unknown, owner: string | undefined = "cust_A") {
  let promise: Promise<unknown> | undefined;
  const close = vi.fn();
  worker.listeners.get("notificationclick")!({
    notification: { close, data: { url, pushOwner: owner } },
    waitUntil: (value: Promise<unknown>) => { promise = value; },
  });
  return { promise, close };
}

describe("push-sw.js", () => {
  it("shows a notification from the JSON payload with the store icon", async () => {
    const worker = load(`${ORIGIN}/push-sw.js?icon=${encodeURIComponent(`${ORIGIN}/favicon.svg`)}`);
    await push(worker, { title: "Order shipped", body: "Your order #1042 is on its way.", url: "/account/orders/ord_1", tag: "order-1042" });
    expect(worker.showNotification).toHaveBeenCalledWith("Order shipped", {
      body: "Your order #1042 is on its way.",
      icon: `${ORIGIN}/favicon.svg`,
      data: { url: "/account/orders/ord_1", pushEpoch: 0, pushOwner: "cust_A" },
      tag: "order-1042",
      renotify: true,
    });
  });

  it("requests a fresh native alert for tagged updates but never renotifies an empty tag", async () => {
    const worker = load();
    await push(worker, { title: "First", tag: "order:1" });
    await push(worker, { title: "Update", tag: "order:1" });
    for (const call of worker.showNotification.mock.calls) {
      expect((call as unknown[])[1]).toMatchObject({ tag: "order:1", renotify: true });
      expect((call as unknown[])[1]).not.toHaveProperty("silent");
    }
    const untagged = load();
    await push(untagged, { title: "First", tag: "" });
    expect((untagged.showNotification.mock.calls[0] as unknown[])[1]).not.toHaveProperty("renotify");
  });

  it("accepts an https icon from the media CDN and ignores any other scheme", async () => {
    const cdn = load(`${ORIGIN}/push-sw.js?icon=${encodeURIComponent("https://cdn.example/logo.png")}`);
    await push(cdn, { title: "A" });
    expect((cdn.showNotification.mock.calls[0] as unknown[])[1]).toMatchObject({ icon: "https://cdn.example/logo.png" });
    const bad = load(`${ORIGIN}/push-sw.js?icon=${encodeURIComponent("http://evil.example/x.png")}`);
    await push(bad, { title: "A" });
    expect(((bad.showNotification.mock.calls[0] as unknown[])[1] as { icon?: string }).icon).toBeUndefined();
  });

  it("still shows something for a push without a readable payload, as browsers require", async () => {
    const worker = load();
    await push(worker, "not json", true);
    expect(worker.showNotification).toHaveBeenCalledTimes(1);
    expect((worker.showNotification.mock.calls[0] as unknown[])[0]).toBe("shop.example");
  });

  it("turns an off-site url into the front page", async () => {
    for (const url of ["https://evil.example/x", "//evil.example", "/\\evil.example", "javascript:alert(1)"]) {
      const worker = load();
      await push(worker, { title: "A", url });
      expect(((worker.showNotification.mock.calls[0] as unknown[])[1] as { data: { url: string } }).data.url).toBe("/");
    }
  });

  it("a click focuses the open tab already on the page", async () => {
    const worker = load();
    const focus = vi.fn(async () => ({}));
    worker.clients.list = [
      { url: `${ORIGIN}/cart`, focus: vi.fn(), navigate: vi.fn() },
      { url: `${ORIGIN}/account/orders/ord_1`, focus, navigate: vi.fn() },
    ];
    const { promise, close } = click(worker, "/account/orders/ord_1");
    await promise;
    expect(close).toHaveBeenCalled();
    expect(focus).toHaveBeenCalled();
    expect(worker.openWindow).not.toHaveBeenCalled();
  });

  it("a click takes another open store tab to the url, else opens it", async () => {
    const worker = load();
    const focus = vi.fn(async () => ({}));
    const navigate = vi.fn(async () => ({ focus }));
    worker.clients.list = [{ url: `${ORIGIN}/cart`, focus, navigate }, { url: "https://other.example/", focus: vi.fn(), navigate: vi.fn() }];
    await click(worker, "/account/orders/ord_1").promise;
    expect(navigate).toHaveBeenCalledWith("/account/orders/ord_1");
    expect(worker.openWindow).not.toHaveBeenCalled();

    const closed = load();
    await click(closed, "/account/orders/ord_1").promise;
    expect(closed.openWindow).toHaveBeenCalledWith("/account/orders/ord_1");
    const bare = load();
    await click(bare, "").promise;
    expect(bare.openWindow).toHaveBeenCalledWith("/");
  });

  it("a click without a url just focuses an open store tab", async () => {
    const worker = load();
    const focus = vi.fn(async () => ({}));
    worker.clients.list = [{ url: `${ORIGIN}/`, focus, navigate: vi.fn() }];
    await click(worker, "").promise;
    expect(focus).toHaveBeenCalled();
    expect(worker.openWindow).not.toHaveBeenCalled();
  });

  it.each(["focus-reject", "focus-null", "navigate-reject", "navigate-null"])("opens the destination when a tab cannot handle %s", async (failure) => {
    const worker = load();
    const focus = vi.fn(async () => {
      if (failure === "focus-reject") throw new Error("closed");
      return null;
    });
    const navigate = vi.fn(async () => {
      if (failure === "navigate-reject") throw new Error("uncontrolled");
      return null;
    });
    worker.clients.list = [{ url: `${ORIGIN}${failure.startsWith("focus") ? "/account/orders/ord_1" : "/cart"}`, focus, navigate }];
    await click(worker, "/account/orders/ord_1").promise;
    expect(worker.openWindow).toHaveBeenCalledExactlyOnceWith("/account/orders/ord_1");
  });

  it("does not duplicate a successfully navigated destination when focusing it fails", async () => {
    const worker = load();
    const focus = vi.fn(async () => { throw new Error("not focusable"); });
    worker.clients.list = [{ url: `${ORIGIN}/cart`, navigate: vi.fn(async () => ({ focus })) }];
    await click(worker, "/account/orders/ord_1").promise;
    expect(focus).toHaveBeenCalledOnce();
    expect(worker.openWindow).not.toHaveBeenCalled();
  });

  it.each(["other-account", "signed-out", "offline", "legacy"])("does not open an old private destination for %s", async (kind) => {
    const worker = load();
    if (kind === "other-account") worker.fetchSession.mockResolvedValue(new Response(JSON.stringify({ success: true, data: { authenticated: true, customer: { customerId: "cust_B" } } })));
    if (kind === "signed-out") worker.fetchSession.mockResolvedValue(new Response(JSON.stringify({ success: true, data: { authenticated: false } })));
    if (kind === "offline") worker.fetchSession.mockRejectedValue(new Error("offline"));
    await click(worker, "/account/orders/ord_1", kind === "legacy" ? "" : "cust_A").promise;
    expect(worker.openWindow).toHaveBeenCalledExactlyOnceWith("/");
  });

  it("takes an existing tab home when its notification belongs to a previous account", async () => {
    const worker = load();
    worker.fetchSession.mockResolvedValue(new Response(JSON.stringify({ success: true, data: { authenticated: false } })));
    const focus = vi.fn(async () => ({}));
    const navigate = vi.fn(async () => ({ focus }));
    worker.clients.list = [{ url: `${ORIGIN}/account/orders/old`, focus, navigate }];
    await click(worker, "/account/orders/old").promise;
    expect(navigate).toHaveBeenCalledExactlyOnceWith("/");
    expect(worker.openWindow).not.toHaveBeenCalled();
  });

  it("does not revive a private click after logout and reenrollment during its identity read", async () => {
    const worker = load();
    let finish!: (value: Response) => void;
    worker.fetchSession.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const pending = click(worker, "/account/orders/old").promise;
    let logout!: Promise<unknown>;
    worker.listeners.get("message")!({ data: { type: "scalius:push:sign-out" }, waitUntil: (value: Promise<unknown>) => { logout = value; } });
    await logout;
    worker.listeners.get("message")!({ data: { type: "scalius:push:enrolled", startedAt: Date.now() + 1 } });
    finish(new Response(JSON.stringify({ success: true, data: { authenticated: true, customer: { customerId: "cust_A" } } })));
    await pending;
    expect(worker.openWindow).toHaveBeenCalledExactlyOnceWith("/");
  });

  it("abandons a stalled click identity read before the browser's short window-opening allowance expires", async () => {
    vi.useFakeTimers();
    try {
      const worker = load();
      worker.fetchSession.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
        init.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }));
      const pending = click(worker, "/account/orders/ord_1").promise;
      await vi.advanceTimersByTimeAsync(800);
      await pending;
      expect(worker.openWindow).toHaveBeenCalledExactlyOnceWith("/");
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});
