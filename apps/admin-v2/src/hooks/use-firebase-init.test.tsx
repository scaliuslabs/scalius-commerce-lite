// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFirebaseInit } from "./use-firebase-init";

const mocks = vi.hoisted(() => ({
  config: vi.fn(),
  getToken: vi.fn(),
  onMessage: vi.fn(),
  register: vi.fn(),
  permission: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: vi.fn() }));
vi.mock("@firebase/app", () => ({ getApps: () => [{}], initializeApp: () => ({}) }));
vi.mock("@firebase/messaging", () => ({
  getMessaging: () => ({}), getToken: mocks.getToken, onMessage: mocks.onMessage,
}));
vi.mock("~/lib/api-query-options/firebase", () => ({
  firebaseConfigQueryOptions: () => ({ queryKey: ["firebase-test-config"], queryFn: mocks.config }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

describe("useFirebaseInit registration acknowledgment", () => {
  let root: Root;
  let container: HTMLDivElement;
  let client: QueryClient;
  let hook: ReturnType<typeof useFirebaseInit>;
  const config = { apiKey: "synthetic-public-key", vapidKey: "synthetic-public-vapid" };

  beforeEach(() => {
    vi.resetAllMocks();
    mocks.config.mockResolvedValue(config);
    mocks.getToken.mockResolvedValue("synthetic-nonfunctional-token");
    mocks.onMessage.mockReturnValue(() => undefined);
    mocks.register.mockImplementation(async () => new Response(null, { status: 200 }));
    mocks.permission.mockResolvedValue("granted");
    vi.stubGlobal("Notification", { permission: "granted", requestPermission: mocks.permission });
    vi.stubGlobal("navigator", {
      userAgent: "Test browser",
      serviceWorker: { register: vi.fn(async () => ({})) },
    });
    vi.stubGlobal("fetch", mocks.register);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(() => {
    act(() => root.unmount());
    client.clear();
    document.body.replaceChildren();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function mount(userId: string | undefined = "synthetic-admin") {
    function Harness() {
      hook = useFirebaseInit(userId);
      return <output>{hook.status}</output>;
    }
    await act(async () => root.render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>));
  }

  it.each(["HTTP failure", "network rejection"])("keeps %s retryable until the server acknowledges registration", async (failure) => {
    const registration = deferred<Response>();
    mocks.register.mockReturnValueOnce(registration.promise);
    await mount();
    let attempt!: Promise<void>;
    await act(async () => { attempt = hook.enablePushNotifications(); });
    await vi.waitFor(() => expect(mocks.register).toHaveBeenCalledOnce());
    expect(container.textContent).toBe("loading");
    expect(mocks.onMessage).not.toHaveBeenCalled();

    await act(async () => {
      if (failure === "HTTP failure") registration.resolve(new Response("Failed", { status: 500 }));
      else registration.reject(new TypeError("Synthetic sensitive provider detail"));
      await attempt;
    });
    expect(container.textContent).toBe("error");
    expect(mocks.onMessage).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith("Firebase notification init failed");

    await act(async () => hook.enablePushNotifications());
    expect(container.textContent).toBe("enabled");
    expect(mocks.register).toHaveBeenCalledTimes(2);
    expect(mocks.register).toHaveBeenLastCalledWith("/api/v1/admin/fcm-token", expect.objectContaining({ method: "POST" }));
    expect(mocks.onMessage).toHaveBeenCalledOnce();
    await act(async () => hook.enablePushNotifications());
    expect(mocks.register).toHaveBeenCalledTimes(2);
    expect(mocks.onMessage).toHaveBeenCalledOnce();
  });

  it("coalesces overlapping Enable calls before configuration resolves and keeps success idempotent", async () => {
    const configuration = deferred<typeof config>();
    mocks.config.mockReturnValueOnce(configuration.promise);
    await mount();
    let attempts!: Promise<void>[];
    await act(async () => {
      attempts = [hook.enablePushNotifications(), hook.enablePushNotifications()];
    });
    expect(container.textContent).toBe("loading");
    await act(async () => {
      configuration.resolve(config);
      await Promise.all(attempts);
    });
    expect(container.textContent).toBe("enabled");
    expect(mocks.getToken).toHaveBeenCalledOnce();
    expect(mocks.register).toHaveBeenCalledOnce();
    expect(mocks.onMessage).toHaveBeenCalledOnce();
    await act(async () => hook.enablePushNotifications());
    expect(mocks.register).toHaveBeenCalledOnce();
    expect(mocks.onMessage).toHaveBeenCalledOnce();
  });

  it.each([
    ["unconfigured", "unconfigured"], ["dismissed permission", "idle"], ["empty token", "error"],
  ])("allows an explicit retry after %s exits early", async (scenario, status) => {
    if (scenario === "unconfigured") mocks.config.mockResolvedValueOnce({});
    if (scenario === "empty token") mocks.getToken.mockResolvedValueOnce("");
    if (scenario === "dismissed permission") {
      vi.stubGlobal("Notification", { permission: "default", requestPermission: mocks.permission });
      mocks.permission.mockResolvedValueOnce("default");
    }
    await mount();
    await act(async () => hook.enablePushNotifications());
    expect(container.textContent).toBe(status);
    expect(mocks.register).not.toHaveBeenCalled();
    expect(mocks.onMessage).not.toHaveBeenCalled();
    await act(async () => hook.enablePushNotifications());
    expect(container.textContent).toBe("enabled");
    expect(mocks.register).toHaveBeenCalledOnce();
    expect(mocks.onMessage).toHaveBeenCalledOnce();
  });

  it("keeps denied permission from contacting Firebase or registering a device", async () => {
    vi.stubGlobal("Notification", { permission: "denied", requestPermission: mocks.permission });
    await mount();
    await act(async () => hook.enablePushNotifications());
    expect(container.textContent).toBe("denied");
    expect(mocks.config).not.toHaveBeenCalled();
    expect(mocks.permission).not.toHaveBeenCalled();
    expect(mocks.getToken).not.toHaveBeenCalled();
    expect(mocks.register).not.toHaveBeenCalled();
  });
});
