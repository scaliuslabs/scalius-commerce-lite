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

function fakeSubscription() {
  return {
    endpoint: ENDPOINT,
    toJSON: () => ({ endpoint: ENDPOINT, expirationTime: null, keys: { p256dh: "pk", auth: "ak" } }),
    unsubscribe: vi.fn(async () => true),
  };
}

function fakeDeps(options: {
  supported?: boolean;
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
    permission: () => options.permission ?? "default",
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
  it("is hidden when the browser cannot, the store cannot send, or the answer is unreadable", async () => {
    expect((await readPushState(fakeDeps({ supported: false }).deps)).view).toBe("hidden");
    expect((await readPushState(fakeDeps({ answers: { "/push/state": { publicKey: "AQAB", available: false, subscribed: false } } }).deps)).view).toBe("hidden");
    expect((await readPushState(fakeDeps({ answers: { "/push/state": { publicKey: null, available: true, subscribed: false } } }).deps)).view).toBe("hidden");
    expect((await readPushState(fakeDeps({ answers: { "/push/state": null } }).deps)).view).toBe("hidden");
    expect((await readPushState(fakeDeps({ answers: { "/push/state": "nonsense" } }).deps)).view).toBe("hidden");
    const failing = fakeDeps().deps;
    failing.post = vi.fn(async () => { throw new Error("offline"); });
    expect((await readPushState(failing)).view).toBe("hidden");
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

  it("stays hidden when the browser or the store cannot", async () => {
    const view = mount();
    await initPushControl(view.section, copy, fakeDeps({ answers: { "/push/state": { publicKey: "AQAB", available: false, subscribed: false } } }).deps);
    expect(view.section.hidden).toBe(true);
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
