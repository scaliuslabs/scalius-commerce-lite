// @vitest-environment happy-dom
// My account → "Notifications on this device": subscribes this browser to Web
// Push (the worker has a scope of its own), proves it with a test and "Did it
// arrive?", says exactly why a browser cannot receive them, and lists the staff
// member's own devices with their delivery, "Send test" and "Remove".

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@scalius/shared/push-sign-out", async (original) => ({
  ...await original<typeof import("@scalius/shared/push-sign-out")>(),
  messagePushWorker: vi.fn(async () => true),
}));

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), delete: vi.fn() }));
vi.mock("~/lib/api", () => ({
  apiClient: api,
  apiData: async (call: Promise<{ data?: { data?: unknown } }>) => (await call).data?.data,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { setLocale } from "~/i18n";
import { ThisDeviceNotifications } from "./ThisDeviceNotifications";
import { applicationServerKey, turnOnThisDevice } from "~/lib/web-push";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ok = (data: unknown) => Promise.resolve({ data: { success: true, data } });
// A 65-byte P-256 point is what a real key decodes to; any URL-safe base64 will do here.
const PUBLIC_KEY = "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U";

interface FakeSubscription {
  endpoint: string;
  options: { applicationServerKey: ArrayBuffer | null };
  toJSON: () => { endpoint: string; keys: { p256dh: string; auth: string } };
  unsubscribe: ReturnType<typeof vi.fn>;
}

function fakeSubscription(endpoint = "https://push.example/abc"): FakeSubscription {
  return {
    endpoint,
    options: { applicationServerKey: applicationServerKey(PUBLIC_KEY).buffer },
    toJSON: () => ({ endpoint, keys: { p256dh: "p256", auth: "auth" } }),
    unsubscribe: vi.fn(async () => true),
  };
}

interface Browser {
  register: ReturnType<typeof vi.fn>;
  getRegistration: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
  getSubscription: () => Promise<FakeSubscription | null>;
  requestPermission: ReturnType<typeof vi.fn>;
}

/** A browser with Web Push: a registration whose worker is already active. */
function installBrowser(existing: FakeSubscription | null = null, permission: NotificationPermission = "default"): Browser {
  let current = existing;
  const getSubscription = vi.fn(async () => current);
  const subscribe = vi.fn(async () => {
    current = fakeSubscription(existing ? "https://push.example/replacement" : undefined);
    return current;
  });
  const registration = { active: {}, installing: null, waiting: null, pushManager: { getSubscription, subscribe } };
  const register = vi.fn(async () => registration);
  const getRegistration = vi.fn(async () => (current ? registration : undefined));
  const requestPermission = vi.fn(async () => {
    permission = "granted";
    return "granted" as NotificationPermission;
  });
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { register, getRegistration } });
  vi.stubGlobal("PushManager", class {});
  Object.defineProperty(window, "PushManager", { configurable: true, value: class {} });
  vi.stubGlobal("Notification", { get permission() { return permission; }, requestPermission });
  Object.defineProperty(navigator, "userAgent", {
    configurable: true,
    value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  });
  return { register, getRegistration, subscribe, getSubscription, requestPermission };
}

let host: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

async function mount() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root.render(
    <QueryClientProvider client={queryClient}>
      <ThisDeviceNotifications />
    </QueryClientProvider>,
  ));
  await flush();
}

const button = (label: string) => [...host.querySelectorAll("button")].find((element) => element.textContent === label);

beforeEach(() => {
  setLocale("en");
  Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
  setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36");
  localStorage.clear();
  document.body.innerHTML = "";
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  api.get.mockReset();
  api.post.mockReset();
  api.delete.mockReset();
  api.post.mockImplementation(() => ok({ id: "wpd_this" }));
  api.delete.mockImplementation(() => Promise.resolve({ response: { status: 204 } }));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, "PushManager");
});

const THIS = { id: "wpd_this", deviceLabel: "Chrome on macOS", lastSuccessAt: null, createdAt: "2026-10-01T00:00:00.000Z", failureCount: 0 };
const PHONE = { id: "wpd_phone", deviceLabel: "Safari on iOS", lastSuccessAt: "2026-10-02T10:00:00.000Z", createdAt: "2026-10-01T00:00:00.000Z", failureCount: 0 };

function setUserAgent(value: string, touchPoints = 0) {
  Object.defineProperty(navigator, "userAgent", { configurable: true, value });
  Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, value: touchPoints });
}

describe("Notifications on this device", () => {
  it("says this browser has no Web Push, and still lists the staff member's devices", async () => {
    Reflect.deleteProperty(navigator, "serviceWorker");
    api.get.mockImplementation(() => ok({ publicKey: PUBLIC_KEY, available: true, devices: [PHONE] }));
    await mount();
    expect(host.textContent).toContain("This browser can't show notifications");
    expect(button("Turn on")).toBeUndefined();
    expect(host.textContent).toContain("Safari on iOS");
  });

  it("on iPhone in Safari, explains Apple's Home Screen rule with the steps", async () => {
    Reflect.deleteProperty(navigator, "serviceWorker");
    setUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1", 5);
    api.get.mockImplementation(() => ok({ publicKey: PUBLIC_KEY, available: true, devices: [] }));
    await mount();
    expect(host.textContent).toContain("Add the dashboard to your Home Screen first");
    expect(host.textContent).toContain("Tap Add to Home Screen, then Add.");
    expect(button("Turn on")).toBeUndefined();
  });

  it("says the store needs an https address when the Worker cannot send", async () => {
    installBrowser();
    api.get.mockImplementation(() => ok({ publicKey: null, available: false, devices: [] }));
    await mount();
    expect(host.textContent).toContain("https web address");
    expect(button("Turn on")).toBeUndefined();
  });

  it("says how to unblock notifications in this browser when they are blocked", async () => {
    installBrowser(null, "denied");
    api.get.mockImplementation(() => ok({ publicKey: PUBLIC_KEY, available: true, devices: [] }));
    await mount();
    expect(host.textContent).toContain("Notifications are blocked for the dashboard in this browser.");
    expect(host.textContent).toContain("open Site settings, set Notifications to Allow");
    expect(button("Turn on")).toBeUndefined();
  });

  it("turns on, sends a test at once and asks whether it arrived; No shows what to check", async () => {
    const browser = installBrowser();
    api.get.mockImplementation(() => ok({ publicKey: PUBLIC_KEY, available: true, devices: api.post.mock.calls.length === 0 ? [] : [THIS] }));
    api.post.mockImplementation((request: { url: string }) => (request.url.endsWith("/test") ? ok({ outcome: "sent" }) : ok({ id: "wpd_this" })));
    await mount();
    expect(host.textContent).toContain("Off");
    await vi.waitFor(() => expect(button("Turn on")?.disabled).toBe(false));

    await act(async () => button("Turn on")!.click());
    await flush();

    expect(browser.register).toHaveBeenCalledWith("/web-push-sw.js", { scope: "/web-push/" });
    expect(api.post).toHaveBeenCalledWith(expect.objectContaining({
      url: "/api/v1/admin/web-push/subscriptions",
      body: { endpoint: "https://push.example/abc", keys: { p256dh: "p256", auth: "auth" }, deviceLabel: "Chrome on macOS" },
    }));
    await vi.waitFor(() => expect(api.post).toHaveBeenCalledWith(expect.objectContaining({
      url: "/api/v1/admin/web-push/devices/wpd_this/test",
      body: { title: "Test notification", body: "This is your test notification from Scalius." },
    })));
    await vi.waitFor(() => expect(host.textContent).toContain("Did the test notification appear outside the dashboard?"));
    expect(button("Turn off")).toBeDefined();

    await act(async () => button("Nothing appeared")!.click());
    expect(host.textContent).toContain("Turn off Focus or Do Not Disturb.");
    expect(host.textContent).toContain("enable notification sounds");
    await act(async () => button("It appeared now")!.click());
    expect(button("Yes, but no sound")).toBeDefined();
    await act(async () => button("Nothing appeared")!.click());
    await act(async () => button("Send again")!.click());
    await flush();
    expect(api.post.mock.calls.filter(([request]) => (request as { url: string }).url.endsWith("/test"))).toHaveLength(2);
    expect(button("Yes, with sound")).toBeDefined();
    await act(async () => button("Yes, but no sound")!.click());
    expect(host.textContent).toContain("The notification appeared without sound. Sound depends on your browser and device settings");
    expect(host.textContent).not.toContain("Turn off Focus or Do Not Disturb.");
    expect(button("Nothing appeared")).toBeUndefined();
    expect(button("Turn off")).toBeDefined();
  });

  it("saves nothing when the person refuses the browser's question", async () => {
    const browser = installBrowser(null, "default");
    browser.requestPermission.mockImplementation(async () => "default");
    api.get.mockImplementation(() => ok({ publicKey: PUBLIC_KEY, available: true, devices: [] }));
    await mount();
    await vi.waitFor(() => expect(button("Turn on")?.disabled).toBe(false));
    await act(async () => button("Turn on")!.click());
    await flush();
    expect(browser.subscribe).not.toHaveBeenCalled();
    expect(api.post).not.toHaveBeenCalled();
  });

  it("turns off: tells the API, then unsubscribes the browser", async () => {
    const subscription = fakeSubscription("https://push.example/mine");
    installBrowser(subscription, "granted");
    localStorage.setItem("scalius-web-push-device", "wpd_this");
    api.get.mockImplementation(() => ok({ publicKey: PUBLIC_KEY, available: true, devices: [THIS] }));
    await mount();
    await vi.waitFor(() => expect(button("Turn off")).toBeDefined());
    await act(async () => button("Turn off")!.click());
    await flush();
    expect(api.post).toHaveBeenCalledWith(expect.objectContaining({
      url: "/api/v1/admin/web-push/subscriptions/remove",
      body: { endpoint: "https://push.example/mine" },
    }));
    expect(subscription.unsubscribe).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem("scalius-web-push-device")).toBeNull();
  });

  it("lists devices with their delivery, tests another device and removes it", async () => {
    installBrowser(null, "granted");
    localStorage.setItem("scalius-web-push-device", "wpd_this");
    api.get.mockImplementation(() => ok({ publicKey: PUBLIC_KEY, available: true, devices: [THIS, { ...PHONE, failureCount: 2 }] }));
    api.post.mockImplementation(() => ok({ outcome: "failed" }));
    await mount();
    expect(host.textContent).toContain("Your devices");
    expect(host.textContent).toContain("This device");
    expect(host.textContent).toContain("No notification sent yet");
    expect(host.textContent).toContain("Last sent");
    expect(host.textContent).toContain("Not delivering");

    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Send test to Safari on iOS"]')!.click());
    await flush();
    expect(api.post).toHaveBeenCalledWith(expect.objectContaining({ url: "/api/v1/admin/web-push/devices/wpd_phone/test" }));
    expect(host.textContent).toContain("Couldn't reach this device.");

    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Remove Safari on iOS"]')!.click());
    await flush();
    expect(api.delete).toHaveBeenCalledWith({ url: "/api/v1/admin/web-push/devices/wpd_phone" });
  });

  it("shows Off for an old key and replaces it on explicit Turn on", async () => {
    const subscription = fakeSubscription();
    subscription.options.applicationServerKey = applicationServerKey("AQAB").buffer;
    const browser = installBrowser(subscription, "granted");
    localStorage.setItem("scalius-web-push-device", "wpd_this");
    api.get.mockImplementation(() => ok({ publicKey: PUBLIC_KEY, available: true, devices: [THIS] }));
    api.post.mockImplementation((request: { url: string }) => request.url.endsWith("/test") ? ok({ outcome: "sent" }) : ok({ id: "wpd_this" }));
    await mount();
    await vi.waitFor(() => expect(button("Turn on")?.disabled).toBe(false));
    expect(subscription.unsubscribe).not.toHaveBeenCalled();
    expect(browser.subscribe).not.toHaveBeenCalled();
    await act(async () => button("Turn on")!.click());
    await flush();
    expect(subscription.unsubscribe).toHaveBeenCalledOnce();
    expect(browser.subscribe).toHaveBeenCalledOnce();
    expect(api.post).toHaveBeenCalledWith(expect.objectContaining({
      url: "/api/v1/admin/web-push/subscriptions/remove",
      body: { endpoint: subscription.endpoint },
    }));
    await vi.waitFor(() => expect(button("Turn off")).toBeDefined());
  });

  it("cleans up only a newly created subscription when saving fails, and clears the remembered id", async () => {
    for (const reuse of [false, true]) {
      const existing = fakeSubscription();
      const browser = installBrowser(reuse ? existing : null, "granted");
      localStorage.setItem("scalius-web-push-device", "wpd_stale");
      api.post.mockRejectedValue(new Error("offline"));
      await expect(turnOnThisDevice(PUBLIC_KEY, "This browser")).rejects.toThrow("offline");
      const subscription = await browser.getSubscription() as FakeSubscription;
      expect(subscription.unsubscribe).toHaveBeenCalledOnce();
      expect(localStorage.getItem("scalius-web-push-device")).toBeNull();
    }
  });

  it("releases the Turn on action after an activation timeout, without subscribing or sending", async () => {
    const browser = installBrowser(null, "granted");
    const worker = Object.assign(new EventTarget(), { state: "installing" });
    browser.register.mockResolvedValue({ active: null, installing: worker, waiting: null, pushManager: { subscribe: browser.subscribe } });
    api.get.mockImplementation(() => ok({ publicKey: PUBLIC_KEY, available: true, devices: [] }));
    await mount();
    await vi.waitFor(() => expect(button("Turn on")?.disabled).toBe(false));
    vi.useFakeTimers();
    try {
      await act(async () => button("Turn on")!.click());
      await act(async () => { await vi.advanceTimersByTimeAsync(15_001); });
      expect(button("Turn on")?.disabled).toBe(false);
      expect(browser.subscribe).not.toHaveBeenCalled();
      expect(api.post).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it("reconnects with the new key even when old server-record cleanup fails", async () => {
    const old = fakeSubscription();
    old.options.applicationServerKey = applicationServerKey("AQAB").buffer;
    const browser = installBrowser(old, "granted");
    api.post.mockImplementation((request: { url: string }) => request.url.endsWith("/remove")
      ? Promise.reject(new Error("offline")) : ok({ id: "wpd_new" }));
    await expect(turnOnThisDevice(PUBLIC_KEY, "This browser")).resolves.toEqual({ id: "wpd_new" });
    expect(old.unsubscribe).toHaveBeenCalledOnce();
    expect(browser.subscribe).toHaveBeenCalledOnce();
  });

  it("rechecks on return and leaves a server-removed device off until explicitly enabled", async () => {
    const browser = installBrowser(fakeSubscription(), "granted");
    localStorage.setItem("scalius-web-push-device", "wpd_this");
    let devices = [THIS];
    api.get.mockImplementation(() => ok({ publicKey: PUBLIC_KEY, available: true, devices }));
    await mount();
    await vi.waitFor(() => expect(button("Turn off")).toBeDefined());
    devices = [];
    await act(async () => window.dispatchEvent(new Event("focus")));
    await flush();
    await vi.waitFor(() => expect(button("Turn on")).toBeDefined());
    expect(browser.subscribe).not.toHaveBeenCalled();
    expect(api.post).not.toHaveBeenCalled();
  });
});
