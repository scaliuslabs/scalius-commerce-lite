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
    registration: { showNotification },
  };
  const randomUUID = vi.fn(() => "receipt-id");
  runInNewContext(SOURCE, { self: scope, clients, URL, crypto: { randomUUID } });
  const push = async (payload: unknown) => {
    let pending: Promise<unknown> | undefined;
    listeners.get("push")!({ data: { json: () => payload }, waitUntil: (value: Promise<unknown>) => { pending = value; } });
    await pending;
  };
  return { push, showNotification, postMessage, secondPost, foreignPost, clients, randomUUID };
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

  it("shares one receipt id and timestamp across open tabs and accepts JSON null safely", async () => {
    const sw = worker();
    await sw.push(null);
    expect(sw.showNotification).toHaveBeenCalledWith("Scalius", expect.objectContaining({ body: "" }));
    expect(sw.randomUUID).toHaveBeenCalledOnce();
    const receipt = sw.postMessage.mock.calls[0]![0];
    expect(receipt).toEqual({ type: "scalius:push", id: "receipt-id", at: expect.any(Number), title: "Scalius", body: "", url: "" });
    expect(sw.secondPost).toHaveBeenCalledWith(receipt);
    expect(sw.secondPost.mock.calls[0]![0]).toBe(receipt);
  });
});
