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
    registration: { showNotification },
    clients: {
      claim: vi.fn(async () => undefined),
      matchAll: vi.fn(async () => clients.list),
      openWindow,
    },
  };
  new Function("self", "URL", SOURCE)(scope, URL);
  const wait = async (event: { promise?: Promise<unknown> }) => event.promise;
  return { listeners, showNotification, openWindow, clients, scope, wait };
}

function push(worker: ReturnType<typeof load>, payload: unknown, raw = false) {
  let promise: Promise<unknown> | undefined;
  worker.listeners.get("push")!({
    data: { json: () => (raw ? JSON.parse(String(payload)) : payload) },
    waitUntil: (value: Promise<unknown>) => { promise = value; },
  });
  return promise;
}

function click(worker: ReturnType<typeof load>, url: unknown) {
  let promise: Promise<unknown> | undefined;
  const close = vi.fn();
  worker.listeners.get("notificationclick")!({
    notification: { close, data: { url } },
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
      data: { url: "/account/orders/ord_1" },
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
    const navigate = vi.fn(async () => ({}));
    const focus = vi.fn(async function (this: unknown) { return { navigate }; });
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
});
