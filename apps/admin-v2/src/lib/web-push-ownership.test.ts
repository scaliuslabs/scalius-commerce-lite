// @vitest-environment node
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const cases = [
  { audience: "staff", path: "../../public/web-push-sw.js", url: "https://shop.example/dashboard/web-push-sw.js", owner: "usr_A", session: (id: string) => ({ session: { user: { id }, permissions: ["orders.view"] } }) },
  { audience: "customer", path: "../../../storefront/public/push-sw.js", url: "https://shop.example/push-sw.js", owner: "cust_A", session: (id: string) => ({ success: true, data: { authenticated: true, customer: { customerId: id } } }) },
] as const;

type Event = { data?: unknown; ports?: unknown[]; waitUntil?: (pending: Promise<unknown>) => void };
function worker(config: typeof cases[number]) {
  const listeners = new Map<string, (event: Event) => void>();
  const close = vi.fn();
  const postMessage = vi.fn();
  const showNotification = vi.fn(async (_title: string, _options: NotificationOptions): Promise<void> => undefined);
  const fetchSession = vi.fn(async (_url: string, _options: RequestInit) => new Response(JSON.stringify(config.session(config.owner))));
  const clients = { matchAll: vi.fn(async () => [{ url: "https://shop.example/dashboard/", postMessage }]) };
  const scope = { location: new URL(config.url), clients,
    addEventListener: (name: string, listener: (event: Event) => void) => listeners.set(name, listener),
    registration: { showNotification, getNotifications: vi.fn(async () => [{ close }]) } };
  runInNewContext(readFileSync(new URL(config.path, import.meta.url), "utf8"), { self: scope, clients, URL, Date, fetch: fetchSession, AbortController, setTimeout, clearTimeout });
  const dispatch = async (name: string, data: unknown) => {
    let pending: Promise<unknown> | undefined;
    const ack = vi.fn();
    listeners.get(name)!({ data: name === "push" ? { json: () => data } : data, ports: [{ postMessage: ack }], waitUntil: (value) => { pending = value; } });
    await pending;
    return ack;
  };
  const notification = { title: "PRIVATE", body: "Buyer details", url: "/account/orders/1" };
  const payload = { recipient: { audience: config.audience, id: config.owner }, ...(config.audience === "staff" ? { v: 2, requires: "orders.view", content: notification } : { notification }) };
  return { dispatch, payload, notification, fetchSession, showNotification, postMessage, close };
}

describe.each(cases)("$audience native push account guard", (config) => {
  it("displays only for the current owner through a same-origin, no-store session read", async () => {
    const sw = worker(config);
    await sw.dispatch("push", sw.payload);
    expect(sw.showNotification).toHaveBeenCalledWith("PRIVATE", expect.objectContaining({ body: "Buyer details" }));
    expect(sw.fetchSession).toHaveBeenCalledWith(expect.stringContaining("/api/"), expect.objectContaining({ credentials: "same-origin", cache: "no-store", redirect: "error", signal: expect.any(AbortSignal) }));
    if (config.audience === "staff") expect(sw.postMessage).toHaveBeenCalledWith({ type: "scalius:push" });
  });

  it("fails closed for another account, no session, unreadable session, and legacy payloads", async () => {
    for (const kind of ["other", "gone", "offline", "legacy"]) {
      const sw = worker(config);
      if (kind === "other") sw.fetchSession.mockResolvedValue(new Response(JSON.stringify(config.session("owner_B"))));
      if (kind === "gone") sw.fetchSession.mockResolvedValue(new Response(JSON.stringify({ session: null, data: { authenticated: false } })));
      if (kind === "offline") sw.fetchSession.mockRejectedValue(new Error("offline"));
      await sw.dispatch("push", kind === "legacy" ? sw.notification : sw.payload);
      const [title, options] = sw.showNotification.mock.calls[0]!;
      expect(title).not.toBe("PRIVATE");
      expect(options).not.toHaveProperty("body");
      expect(options.data).toEqual({ url: "" });
      expect(sw.postMessage).not.toHaveBeenCalled();
    }
  });

  it("blocks a push whose identity read was still pending when explicit logout began", async () => {
    const sw = worker(config);
    let resolve!: (response: Response) => void;
    sw.fetchSession.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const pending = sw.dispatch("push", sw.payload);
    await sw.dispatch("message", { type: "scalius:push:sign-out" });
    resolve(new Response(JSON.stringify(config.session(config.owner))));
    await pending;
    expect(sw.showNotification.mock.calls.every(([title]) => title !== "PRIVATE")).toBe(true);
    expect(sw.postMessage).not.toHaveBeenCalled();
  });

  it("closes an in-flight display and withholds staff receipts before acknowledging logout", async () => {
    const sw = worker(config);
    let resolveDisplay!: () => void;
    sw.showNotification.mockReturnValueOnce(new Promise<void>((done) => { resolveDisplay = done; }));
    const pending = sw.dispatch("push", sw.payload);
    await vi.waitFor(() => expect(sw.showNotification).toHaveBeenCalledOnce());
    const logout = sw.dispatch("message", { type: "scalius:push:sign-out" });
    resolveDisplay();
    await pending;
    const ack = await logout;
    expect(sw.close).toHaveBeenCalled();
    expect(ack).toHaveBeenCalledWith({ ok: true });
    expect(sw.postMessage).not.toHaveBeenCalled();
  });

  it("rejects enrollment begun before logout, but permits a later explicit enrollment", async () => {
    const sw = worker(config);
    const earlier = Date.now() - 1;
    await sw.dispatch("message", { type: "scalius:push:sign-out" });
    expect(await sw.dispatch("message", { type: "scalius:push:enrolled", startedAt: earlier })).toHaveBeenCalledWith({ ok: false });
    await sw.dispatch("push", sw.payload);
    expect(sw.showNotification.mock.calls[0]![0]).not.toBe("PRIVATE");
    expect(await sw.dispatch("message", { type: "scalius:push:enrolled", startedAt: Date.now() + 1 })).toHaveBeenCalledWith({ ok: true });
    await sw.dispatch("push", sw.payload);
    expect(sw.showNotification).toHaveBeenLastCalledWith("PRIVATE", expect.objectContaining({ body: "Buyer details" }));
  });
});

describe("staff queued push permission guard", () => {
  it.each([
    { requires: "orders.view", permissions: [], admin: false, allowed: false },
    { requires: "unknown.permission", permissions: ["orders.view"], admin: true, allowed: false },
    { requires: "super_admin", permissions: ["orders.view", "apps.view"], admin: false, allowed: false },
    { requires: "super_admin", permissions: [], admin: true, allowed: true },
    { requires: "self", permissions: [], admin: false, allowed: true },
  ])("checks the current session for $requires (allowed: $allowed)", async ({ requires, permissions, admin, allowed }) => {
    const sw = worker(cases[0]);
    sw.fetchSession.mockImplementation(async () => new Response(JSON.stringify({ session: {
      user: { id: "usr_A", isSuperAdmin: admin }, permissions,
    } })));
    await sw.dispatch("push", { ...sw.payload, requires });
    expect(sw.showNotification.mock.calls[0]![0] === "PRIVATE").toBe(allowed);
    if (!allowed) expect(sw.showNotification.mock.calls[0]![1]).not.toHaveProperty("body");
  });

  it("keeps old owner-only envelopes and missing requirements neutral", async () => {
    const sw = worker(cases[0]);
    for (const payload of [
      { recipient: sw.payload.recipient, notification: sw.notification },
      { ...sw.payload, requires: undefined },
    ]) await sw.dispatch("push", payload);
    expect(sw.fetchSession).not.toHaveBeenCalled();
    for (const [title, options] of sw.showNotification.mock.calls) {
      expect(title).not.toBe("PRIVATE");
      expect(options).not.toHaveProperty("body");
    }
  });

  it("closes private content if permission is revoked during display and emits no receipt", async () => {
    const sw = worker(cases[0]);
    sw.fetchSession.mockResolvedValueOnce(new Response(JSON.stringify(cases[0].session("usr_A"))))
      .mockResolvedValueOnce(new Response(JSON.stringify({ session: { user: { id: "usr_A" }, permissions: [] } })));
    await sw.dispatch("push", sw.payload);
    expect(sw.showNotification).toHaveBeenCalledWith("PRIVATE", expect.objectContaining({ body: "Buyer details" }));
    expect(sw.close).toHaveBeenCalled();
    expect(sw.postMessage).not.toHaveBeenCalled();
  });
});
