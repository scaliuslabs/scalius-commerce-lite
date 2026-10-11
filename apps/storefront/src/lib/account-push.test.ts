// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { accountPushCopy } from "./account-push-copy";
import {
  browserPushDeps,
  decodePublicKey,
  deviceLabelOf,
  initPushControl,
  readPushState,
  turnPushOff,
  turnPushOn,
  type PushDeps,
} from "./account-push";

const ENDPOINT = "https://push.example/send/abc123";

function fakeSubscription(key: string | null = "AQAB") {
  return {
    endpoint: ENDPOINT,
    options: { applicationServerKey: key ? decodePublicKey(key).buffer : null },
    toJSON: () => ({ endpoint: ENDPOINT, expirationTime: null, keys: { p256dh: "pk", auth: "ak" } }),
    unsubscribe: vi.fn(async () => true),
  };
}

function fakeDeps(options: {
  supported?: boolean;
  unsupportedReason?: "unsupported" | "homeScreen";
  permission?: NotificationPermission;
  request?: NotificationPermission;
  subscription?: ReturnType<typeof fakeSubscription> | null;
  answers?: Record<string, unknown>;
} = {}) {
  const subscription = options.subscription === undefined ? null : options.subscription;
  const subscribe = vi.fn(async () => fakeSubscription());
  const registration = {
    pushManager: { getSubscription: vi.fn(async () => subscription), subscribe },
  } as unknown as ServiceWorkerRegistration;
  const post = vi.fn(async (path: string) => {
    const answers = options.answers ?? {};
    return path in answers ? answers[path] : path === "/push/state" ? { publicKey: "AQAB", available: true, subscribed: false } : { ok: true };
  });
  const deps: PushDeps = {
    supported: () => options.supported ?? true,
    unsupportedReason: () => options.unsupportedReason ?? "unsupported",
    permission: () => options.permission ?? (subscription ? "granted" : "default"),
    requestPermission: vi.fn(async () => options.request ?? "granted"),
    getRegistration: vi.fn(async () => (subscription ? registration : undefined)),
    register: vi.fn(async () => registration),
    post,
    deviceLabel: () => "Chrome on Android",
  };
  return { deps, post, subscribe, registration };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("browser notifications state", () => {
  it("shows browser restrictions and unreadable state but hides an unconfigured sender", async () => {
    expect((await readPushState(fakeDeps({ supported: false }).deps)).view).toBe("unsupported");
    expect((await readPushState(fakeDeps({ supported: false, unsupportedReason: "homeScreen" }).deps)).view).toBe("homeScreen");
    expect((await readPushState(fakeDeps({ answers: { "/push/state": { publicKey: "AQAB", available: false, subscribed: false } } }).deps)).view).toBe("hidden");
    expect((await readPushState(fakeDeps({ answers: { "/push/state": { publicKey: null, available: true, subscribed: false } } }).deps)).view).toBe("error");
    expect((await readPushState(fakeDeps({ answers: { "/push/state": null } }).deps)).view).toBe("error");
    expect((await readPushState(fakeDeps({ answers: { "/push/state": "nonsense" } }).deps)).view).toBe("error");
    const failing = fakeDeps().deps;
    failing.post = vi.fn(async () => { throw new Error("offline"); });
    expect((await readPushState(failing)).view).toBe("error");
  });

  it("does not claim On for an old or unreadable key, or silently restore a removed endpoint", async () => {
    for (const key of ["AgAC", null]) {
      const stale = fakeDeps({ subscription: fakeSubscription(key), answers: { "/push/state": { publicKey: "AQAB", available: true, subscribed: true } } });
      expect((await readPushState(stale.deps)).view).toBe("off");
      expect(stale.subscribe).not.toHaveBeenCalled();
      expect(stale.post).toHaveBeenCalledTimes(1);
    }
    const missing = fakeDeps({ subscription: fakeSubscription() });
    expect((await readPushState(missing.deps)).view).toBe("off");
    expect(missing.post).toHaveBeenCalledTimes(1);
  });

  it("is off with no subscription, on when this browser's subscription is the account's, blocked when denied", async () => {
    expect(await readPushState(fakeDeps().deps)).toEqual({ view: "off", publicKey: "AQAB" });
    const subscribed = fakeDeps({ subscription: fakeSubscription(), answers: { "/push/state": { publicKey: "AQAB", available: true, subscribed: true } } });
    expect((await readPushState(subscribed.deps)).view).toBe("on");
    // The browser holds a subscription the account does not know (another account's): off.
    expect((await readPushState(fakeDeps({ subscription: fakeSubscription() }).deps)).view).toBe("off");
    expect((await readPushState(fakeDeps({ permission: "denied" }).deps)).view).toBe("blocked");
  });

  it("asks with the browser's endpoint in the body only", async () => {
    const { deps, post } = fakeDeps({ subscription: fakeSubscription() });
    await readPushState(deps);
    expect(post).toHaveBeenCalledWith("/push/state", { endpoint: ENDPOINT });
    for (const [path] of post.mock.calls) expect(String(path)).not.toContain("push.example");
    const none = fakeDeps();
    await readPushState(none.deps);
    expect(none.post).toHaveBeenCalledWith("/push/state", {});
  });
});

describe("turning notifications on and off", () => {
  it("replaces an old or unreadable key only on an explicit enable, even if server cleanup fails", async () => {
    for (const key of ["AgAC", null]) {
      const old = fakeSubscription(key);
      const { deps, post, subscribe } = fakeDeps({ subscription: old, answers: { "/push/unsubscribe": null } });
      expect(await turnPushOn(deps, "AQAB")).toEqual({ ok: true, view: "on" });
      expect(old.unsubscribe).toHaveBeenCalledOnce();
      expect(post).toHaveBeenCalledWith("/push/unsubscribe", { endpoint: ENDPOINT });
      expect(subscribe).toHaveBeenCalledOnce();
      expect(old.unsubscribe.mock.invocationCallOrder[0]).toBeLessThan(subscribe.mock.invocationCallOrder[0]!);
    }
  });

  it("reuses a matching subscription when explicitly reconnecting it to the account", async () => {
    const subscription = fakeSubscription();
    const { deps, post, subscribe } = fakeDeps({ subscription });
    expect(await turnPushOn(deps, "AQAB")).toEqual({ ok: true, view: "on" });
    expect(subscribe).not.toHaveBeenCalled();
    expect(subscription.unsubscribe).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledWith("/push/subscribe", expect.objectContaining({ endpoint: ENDPOINT }));
  });
  it("asks the browser first, subscribes with the store's key and posts the subscription with a device label", async () => {
    const { deps, post, subscribe } = fakeDeps();
    expect(await turnPushOn(deps, "AQAB")).toEqual({ ok: true, view: "on" });
    expect(deps.requestPermission).toHaveBeenCalledTimes(1);
    const options = (subscribe.mock.calls[0] as unknown as [PushSubscriptionOptionsInit])[0];
    expect(options.userVisibleOnly).toBe(true);
    expect(Array.from(options.applicationServerKey as Uint8Array)).toEqual([1, 0, 1]);
    expect(post).toHaveBeenCalledWith("/push/subscribe", {
      endpoint: ENDPOINT,
      keys: { p256dh: "pk", auth: "ak" },
      deviceLabel: "Chrome on Android",
    });
  });

  it("stays off when the buyer dismisses the prompt, and blocked when the browser denies it", async () => {
    const dismissed = fakeDeps({ request: "default" });
    expect(await turnPushOn(dismissed.deps, "AQAB")).toEqual({ ok: true, view: "off" });
    expect(dismissed.deps.register).not.toHaveBeenCalled();
    const denied = fakeDeps({ request: "denied" });
    expect(await turnPushOn(denied.deps, "AQAB")).toEqual({ ok: true, view: "blocked" });
    expect(denied.deps.register).not.toHaveBeenCalled();
  });

  it("drops the browser's subscription when the account refuses it", async () => {
    const created = fakeSubscription();
    const { deps, subscribe } = fakeDeps({ answers: { "/push/subscribe": null } });
    subscribe.mockResolvedValueOnce(created);
    expect(await turnPushOn(deps, "AQAB")).toEqual({ ok: false, view: "off" });
    expect(created.unsubscribe).toHaveBeenCalled();
  });

  it("preserves a reused subscription on failed saves and rolls back a newly created one on thrown saves", async () => {
    const working = fakeSubscription();
    const reused = fakeDeps({ subscription: working, answers: { "/push/subscribe": null } });
    expect(await turnPushOn(reused.deps, "AQAB")).toEqual({ ok: false, view: "off" });
    expect(working.unsubscribe).not.toHaveBeenCalled();
    const created = fakeSubscription();
    const fresh = fakeDeps();
    fresh.subscribe.mockResolvedValueOnce(created);
    fresh.deps.post = vi.fn(async () => { throw new Error("offline"); });
    expect(await turnPushOn(fresh.deps, "AQAB")).toEqual({ ok: false, view: "off" });
    expect(created.unsubscribe).toHaveBeenCalledOnce();
  });

  it("reports a failure when the browser refuses to subscribe", async () => {
    const { deps, subscribe } = fakeDeps();
    subscribe.mockRejectedValueOnce(new Error("AbortError"));
    expect(await turnPushOn(deps, "AQAB")).toEqual({ ok: false, view: "off" });
  });

  it("turns off at the account first, then in the browser; a refusal keeps it on", async () => {
    const subscription = fakeSubscription();
    const { deps, post } = fakeDeps({ subscription });
    expect(await turnPushOff(deps)).toEqual({ ok: true, view: "off" });
    expect(post).toHaveBeenCalledWith("/push/unsubscribe", { endpoint: ENDPOINT });
    expect(subscription.unsubscribe).toHaveBeenCalled();
    const kept = fakeSubscription();
    const refused = fakeDeps({ subscription: kept, answers: { "/push/unsubscribe": null } });
    expect(await turnPushOff(refused.deps)).toEqual({ ok: false, view: "on" });
    expect(kept.unsubscribe).not.toHaveBeenCalled();
  });
});

describe("pure helpers", () => {
  it("decodes a base64url public key", () => {
    expect(Array.from(decodePublicKey("AQAB"))).toEqual([1, 0, 1]);
    expect(Array.from(decodePublicKey("-_8"))).toEqual([251, 255]);
  });

  it("names the browser coarsely, never by its exact user agent", () => {
    expect(deviceLabelOf("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36")).toBe("Chrome on Android");
    expect(deviceLabelOf("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1")).toBe("Safari on iPhone");
    expect(deviceLabelOf("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36 Edg/126.0")).toBe("Edge on Windows");
    expect(deviceLabelOf("curl/8")).toBe("Browser");
  });

  it("is supported only with a service worker, PushManager and Notification", () => {
    const win = { navigator: { serviceWorker: {} }, PushManager: class {}, Notification: class {} } as unknown as Window & typeof globalThis;
    expect(browserPushDeps(win).supported()).toBe(true);
    const noPush = { navigator: { serviceWorker: {} }, Notification: class {} } as unknown as Window & typeof globalThis;
    expect(browserPushDeps(noPush).supported()).toBe(false);
  });

  it("explains Home Screen setup before rejecting iOS Safari's missing PushManager", () => {
    const win = { navigator: { userAgent: "iPhone", maxTouchPoints: 5 }, matchMedia: () => ({ matches: false }) } as unknown as Window & typeof globalThis;
    expect(browserPushDeps(win).supported()).toBe(false);
    expect(browserPushDeps(win).unsupportedReason?.()).toBe("homeScreen");
  });

  it("waits for the returned push registration to activate instead of another worker's ready promise", async () => {
    const installing = Object.assign(new EventTarget(), { state: "installing" });
    const registration = { installing, waiting: null, active: { state: "activated" } };
    const serviceWorker = {
      register: vi.fn(async () => registration),
      get ready() { throw new Error("Unrelated registration must not be used"); },
    };
    const win = { navigator: { serviceWorker }, document: { querySelector: () => null } } as unknown as Window & typeof globalThis;
    let resolved = false;
    const pending = browserPushDeps(win).register().then((value) => { resolved = true; return value; });
    await Promise.resolve();
    expect(resolved).toBe(false);
    installing.state = "activated";
    installing.dispatchEvent(new Event("statechange"));
    expect(await pending).toBe(registration);
    expect(serviceWorker.register).toHaveBeenCalledWith("/push-sw.js", { scope: "/" });
  });
});

describe("the control", () => {
  const copy = accountPushCopy("en");

  function mount() {
    document.body.innerHTML = `<section data-account-push hidden>
      <p data-push-status></p><p data-push-hint hidden></p><button type="button" data-push-toggle></button>
    </section>`;
    return {
      section: document.querySelector<HTMLElement>("[data-account-push]")!,
      status: document.querySelector<HTMLElement>("[data-push-status]")!,
      hint: document.querySelector<HTMLElement>("[data-push-hint]")!,
      toggle: document.querySelector<HTMLButtonElement>("[data-push-toggle]")!,
    };
  }
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("stays hidden when the store cannot send", async () => {
    const view = mount();
    await initPushControl(view.section, copy, fakeDeps({ answers: { "/push/state": { publicKey: "AQAB", available: false, subscribed: false } } }).deps);
    expect(view.section.hidden).toBe(true);
  });

  it("offers Retry after a read failure and recovers without requesting permission", async () => {
    const view = mount();
    const { deps, post } = fakeDeps({ answers: { "/push/state": null } });
    await initPushControl(view.section, copy, deps);
    expect(view.section.hidden).toBe(false);
    expect(view.status.textContent).toBe(copy.loadFailed);
    expect(view.toggle.textContent).toBe(copy.retry);
    post.mockResolvedValueOnce({ publicKey: "AQAB", available: true, subscribed: false });
    view.toggle.click();
    await flush();
    expect(view.status.textContent).toBe(copy.off);
    expect(deps.requestPermission).not.toHaveBeenCalled();
  });

  it("shows unsupported and Home Screen guidance without an unusable enable button", async () => {
    for (const reason of ["unsupported", "homeScreen"] as const) {
      const view = mount();
      await initPushControl(view.section, copy, fakeDeps({ supported: false, unsupportedReason: reason }).deps);
      expect(view.section.hidden).toBe(false);
      expect(view.status.textContent).toBe(copy[reason]);
      expect(view.hint.textContent).toBe(copy[`${reason}Hint`]);
      expect(view.toggle.hidden).toBe(true);
    }
  });

  it("rechecks permission and server ownership on return without resubscribing", async () => {
    const view = mount();
    const { deps, post, subscribe } = fakeDeps({ permission: "denied" });
    const controller = new AbortController();
    await initPushControl(view.section, copy, deps, controller.signal);
    deps.permission = () => "granted";
    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(view.status.textContent).toBe(copy.off);
    expect(post).toHaveBeenCalledTimes(2);
    expect(subscribe).not.toHaveBeenCalled();
    controller.abort();
    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(post).toHaveBeenCalledTimes(2);
  });

  it("shows Off, turns on, shows On, turns off again, in words", async () => {
    const view = mount();
    const { deps } = fakeDeps();
    await initPushControl(view.section, copy, deps);
    expect(view.section.hidden).toBe(false);
    expect(view.status.textContent).toBe("Off in this browser");
    expect(view.toggle.textContent).toBe("Turn on");
    view.toggle.click();
    expect(view.toggle.disabled).toBe(true);
    expect(view.toggle.textContent).toBe("Working…");
    await flush();
    expect(view.status.textContent).toBe("On in this browser");
    expect(view.toggle.textContent).toBe("Turn off");
    expect(view.toggle.getAttribute("aria-pressed")).toBe("true");
    expect(view.toggle.disabled).toBe(false);
  });

  it("shows Blocked by the browser with how to allow it, and no button", async () => {
    const view = mount();
    await initPushControl(view.section, copy, fakeDeps({ permission: "denied" }).deps);
    expect(view.status.textContent).toBe("Blocked by the browser");
    expect(view.hint.hidden).toBe(false);
    expect(view.hint.textContent).toContain("site settings");
    expect(view.toggle.hidden).toBe(true);
  });

  it("says so, and keeps the state, when the change fails", async () => {
    const view = mount();
    const { deps, subscribe } = fakeDeps();
    subscribe.mockRejectedValueOnce(new Error("no"));
    await initPushControl(view.section, accountPushCopy("bn"), deps);
    expect(view.status.textContent).toBe("এই ব্রাউজারে বন্ধ আছে");
    view.toggle.click();
    await flush();
    expect(view.status.textContent).toBe("এই ব্রাউজারে বন্ধ আছে");
    expect(view.hint.textContent).toBe(accountPushCopy("bn").failed);
  });
});
