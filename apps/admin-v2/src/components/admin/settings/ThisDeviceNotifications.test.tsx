// @vitest-environment happy-dom
// Settings → Notifications → Staff → "Notifications on this device": subscribes
// this browser to Web Push (the worker has a scope of its own), shows On or Off,
// turns it off again, lists the staff member's own browsers with Remove, and is
// hidden in a browser without Web Push or says why when the Worker cannot send.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), delete: vi.fn() }));
vi.mock("~/lib/api", () => ({
  apiClient: api,
  apiData: async (call: Promise<{ data?: { data?: unknown } }>) => (await call).data?.data,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { setLocale } from "~/i18n";
import { ThisDeviceNotifications } from "./ThisDeviceNotifications";

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
    options: { applicationServerKey: null },
    toJSON: () => ({ endpoint, keys: { p256dh: "p256", auth: "auth" } }),
    unsubscribe: vi.fn(async () => true),
  };
}

interface Browser {
  register: ReturnType<typeof vi.fn>;
  getRegistration: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
  getSubscription: ReturnType<typeof vi.fn>;
  requestPermission: ReturnType<typeof vi.fn>;
}

/** A browser with Web Push: a registration whose worker is already active. */
function installBrowser(existing: FakeSubscription | null = null, permission: NotificationPermission = "default"): Browser {
  let current = existing;
  const getSubscription = vi.fn(async () => current);
  const subscribe = vi.fn(async () => {
    current = fakeSubscription();
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

describe("Notifications on this device", () => {
  it("renders nothing in a browser without Web Push", async () => {
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: undefined });
    Reflect.deleteProperty(navigator, "serviceWorker");
    await mount();
    expect(host.textContent).toBe("");
    expect(api.get).not.toHaveBeenCalled();
  });

  it("says why in one line, and offers no switch, when the Worker cannot send", async () => {
    installBrowser();
    api.get.mockImplementation(() => ok({ publicKey: null, available: false, devices: [] }));
    await mount();
    expect(host.textContent).toContain("Notifications on this device");
    expect(host.textContent).toContain("https web address");
    expect(button("Turn on")).toBeUndefined();
  });

  it("subscribes this browser under its own scope and saves it with a short device label", async () => {
    const browser = installBrowser();
    // The API lists the browser once it has been saved.
    api.get.mockImplementation(() => ok({
      publicKey: PUBLIC_KEY,
      available: true,
      devices: api.post.mock.calls.length === 0 ? [] : [{ id: "wpd_this", deviceLabel: "Chrome on macOS", lastSuccessAt: null, createdAt: "2026-10-01T00:00:00.000Z" }],
    }));
    await mount();
    expect(host.textContent).toContain("Off");
    await vi.waitFor(() => expect(button("Turn on")?.disabled).toBe(false));

    await act(async () => button("Turn on")!.click());
    await flush();

    expect(browser.requestPermission).toHaveBeenCalledTimes(1);
    expect(browser.register).toHaveBeenCalledWith("/web-push-sw.js", { scope: "/web-push/" });
    const options = browser.subscribe.mock.calls[0]![0] as { userVisibleOnly: boolean; applicationServerKey: Uint8Array };
    expect(options.userVisibleOnly).toBe(true);
    expect(options.applicationServerKey).toBeInstanceOf(Uint8Array);
    expect(options.applicationServerKey.length).toBe(65);
    expect(api.post).toHaveBeenCalledWith(expect.objectContaining({
      url: "/api/v1/admin/web-push/subscriptions",
      body: { endpoint: "https://push.example/abc", keys: { p256dh: "p256", auth: "auth" }, deviceLabel: "Chrome on macOS" },
    }));
    expect(localStorage.getItem("scalius-web-push-device")).toBe("wpd_this");
    await vi.waitFor(() => expect(host.textContent).toContain("On"));
    expect(button("Turn off")).toBeDefined();
  });

  it("saves nothing when the browser blocks notifications", async () => {
    const browser = installBrowser(null, "default");
    browser.requestPermission.mockImplementation(async () => "denied");
    api.get.mockImplementation(() => ok({ publicKey: PUBLIC_KEY, available: true, devices: [] }));
    await mount();
    await vi.waitFor(() => expect(button("Turn on")?.disabled).toBe(false));
    await act(async () => button("Turn on")!.click());
    await flush();
    expect(browser.subscribe).not.toHaveBeenCalled();
    expect(api.post).not.toHaveBeenCalled();
    expect(host.textContent).toContain("blocks notifications");
  });

  it("turns off: tells the API, then unsubscribes the browser", async () => {
    const subscription = fakeSubscription("https://push.example/mine");
    installBrowser(subscription, "granted");
    localStorage.setItem("scalius-web-push-device", "wpd_this");
    api.get.mockImplementation(() => ok({
      publicKey: PUBLIC_KEY,
      available: true,
      devices: [{ id: "wpd_this", deviceLabel: "Chrome on macOS", lastSuccessAt: null, createdAt: "2026-10-01T00:00:00.000Z" }],
    }));
    await mount();
    await vi.waitFor(() => expect(button("Turn off")).toBeDefined());
    expect(host.textContent).toContain("On");

    await act(async () => button("Turn off")!.click());
    await flush();

    expect(api.post).toHaveBeenCalledWith(expect.objectContaining({
      url: "/api/v1/admin/web-push/subscriptions/remove",
      body: { endpoint: "https://push.example/mine" },
    }));
    expect(subscription.unsubscribe).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem("scalius-web-push-device")).toBeNull();
  });

  it("lists the staff member's own browsers and removes another one by id", async () => {
    installBrowser(null, "granted");
    localStorage.setItem("scalius-web-push-device", "wpd_this");
    api.get.mockImplementation(() => ok({
      publicKey: PUBLIC_KEY,
      available: true,
      devices: [
        { id: "wpd_this", deviceLabel: "Chrome on macOS", lastSuccessAt: null, createdAt: "2026-10-01T00:00:00.000Z" },
        { id: "wpd_phone", deviceLabel: "Safari on iOS", lastSuccessAt: "2026-10-02T10:00:00.000Z", createdAt: "2026-10-01T00:00:00.000Z" },
      ],
    }));
    await mount();
    expect(host.textContent).toContain("Your devices");
    expect(host.textContent).toContain("Chrome on macOS");
    expect(host.textContent).toContain("This device");
    expect(host.textContent).toContain("No alert yet");
    expect(host.textContent).toContain("Last alert");

    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Remove Safari on iOS"]')!.click());
    await flush();
    expect(api.delete).toHaveBeenCalledWith({ url: "/api/v1/admin/web-push/devices/wpd_phone" });
  });
});
