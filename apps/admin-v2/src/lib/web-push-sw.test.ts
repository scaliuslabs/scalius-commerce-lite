// @vitest-environment node
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const SOURCE = readFileSync(new URL("../../public/web-push-sw.js", import.meta.url), "utf8");

function worker() {
  const listeners = new Map<string, (event: unknown) => void>();
  const showNotification = vi.fn(async (_title: string, _options: NotificationOptions) => undefined);
  const postMessage = vi.fn();
  const secondPost = vi.fn();
  const foreignPost = vi.fn();
  const clients = { matchAll: vi.fn(async () => [
    { url: "https://shop.example/dashboard/orders", postMessage },
    { url: "https://shop.example/dashboard/", postMessage: secondPost },
    { url: "https://elsewhere.example/dashboard/", postMessage: foreignPost },
  ]) };
  const scope = {
    location: new URL("https://shop.example/dashboard/web-push-sw.js"),
    addEventListener: (kind: string, listener: (event: unknown) => void) => listeners.set(kind, listener),
    registration: { showNotification, getNotifications: vi.fn(async () => []) },
  };
  const fetchSession = vi.fn(async () => new Response(JSON.stringify({ session: { user: { id: "usr_A" }, permissions: ["orders.view"] } })));
  runInNewContext(SOURCE, { self: scope, clients, URL, fetch: fetchSession, AbortController, setTimeout, clearTimeout });
  const push = async (payload: unknown) => {
    let pending: Promise<unknown> | undefined;
    listeners.get("push")!({ data: { json: () => ({ recipient: { audience: "staff", id: "usr_A" }, notification: payload }) }, waitUntil: (value: Promise<unknown>) => { pending = value; } });
    await pending;
  };
  return { push, showNotification, postMessage, secondPost, foreignPost, clients };
}

describe("staff push native alerts", () => {
  it("renotifies tagged replacements while preserving dashboard scope and device sound settings", async () => {
    const sw = worker();
    for (const title of ["First", "Again"]) await sw.push({ title, body: "Test", tag: "scalius-test-push" });
    expect(sw.showNotification).toHaveBeenCalledTimes(2);
    for (const [, options] of sw.showNotification.mock.calls) {
      expect(options).toMatchObject({ tag: "scalius-test-push", renotify: true, icon: "https://shop.example/dashboard/favicon.png" });
      expect(options).not.toHaveProperty("silent");
    }
    expect(sw.postMessage).toHaveBeenCalledTimes(2);
    expect(sw.foreignPost).not.toHaveBeenCalled();
  });

  it("shows an untagged alert with no open dashboard and never uses renotify without a tag", async () => {
    const sw = worker();
    sw.clients.matchAll.mockResolvedValue([]);
    await sw.push({ title: "Order", tag: "" });
    expect(sw.showNotification).toHaveBeenCalledOnce();
    expect(sw.showNotification.mock.calls[0]![1]).not.toHaveProperty("renotify");
    expect(sw.showNotification.mock.calls[0]![1]).not.toHaveProperty("tag");
  });

  it("sends only an account-free refresh hint and treats a missing notification as neutral", async () => {
    const sw = worker();
    await sw.push({ title: "Private", body: "Buyer details" });
    expect(sw.postMessage).toHaveBeenCalledWith({ type: "scalius:push" });
    expect(sw.secondPost.mock.calls[0]![0]).toBe(sw.postMessage.mock.calls[0]![0]);
    sw.postMessage.mockClear();
    await sw.push(null);
    expect(sw.showNotification).toHaveBeenLastCalledWith("Scalius", expect.not.objectContaining({ body: expect.any(String) }));
    expect(sw.postMessage).not.toHaveBeenCalled();
  });
});
