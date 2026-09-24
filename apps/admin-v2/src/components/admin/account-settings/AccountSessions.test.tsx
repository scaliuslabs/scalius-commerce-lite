// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountSessions } from "./AccountSessions";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({ list: vi.fn(), signOutOne: vi.fn(), signOutOthers: vi.fn() }));

vi.mock("~/lib/api", () => ({ apiData: (call: unknown) => call }));
vi.mock("~/lib/api-query-options/auth-management", () => ({
  accountSessionsQueryOptions: () => ({ queryKey: ["auth", "sessions"], queryFn: api.list }),
}));
vi.mock("~/lib/query-keys", () => ({ queryKeys: { auth: { sessions: () => ["auth", "sessions"] } } }));
vi.mock("@scalius/api-client/sdk", () => ({
  deleteApiV1AdminAuthSessionsByCommandId: api.signOutOne,
  deleteApiV1AdminAuthSessions: api.signOutOthers,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const session = (commandId: string, current: boolean, deviceLabel: string, network: { networkHint?: string | null; localNetwork?: boolean } = {}) => ({
  commandId, current, deviceLabel, deviceType: "desktop", networkHint: null, localNetwork: false, ...network, twoFactorVerified: true,
  impersonated: false, createdAt: "2026-09-20T10:00:00Z", lastActiveAt: "2026-09-24T10:00:00Z", expiresAt: "2026-10-24T10:00:00Z",
});

async function flush() {
  for (let index = 0; index < 4; index += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
}

const buttonIn = (scope: ParentNode, name: string) =>
  [...scope.querySelectorAll("button")].find((item) => item.textContent?.trim() === name) as HTMLButtonElement;

describe("AccountSessions", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    Object.values(api).forEach((mock) => mock.mockReset());
    api.list.mockResolvedValue({
      sessions: [
        session("cmd_this", true, "Chrome · macOS", { localNetwork: true }),
        session("cmd_phone", false, "Safari · iPhone", { networkHint: "203.0.113.x" }),
        session("cmd_unknown", false, ""),
      ],
      hasMore: false,
    });
    api.signOutOne.mockResolvedValue({});
    api.signOutOthers.mockResolvedValue({ revokedCount: 1 });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    act(() => root.render(<QueryClientProvider client={client}><AccountSessions /></QueryClientProvider>));
    await flush();
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
  });

  it("names the local network in words and masks a public address", () => {
    expect(host.textContent).toContain("Local network");
    expect(host.textContent).toContain("Network 203.0.113.x");
    expect(host.textContent).not.toContain("0000:");
  });

  it("names a device the API couldn't recognise in the dashboard's language", () => {
    expect(host.textContent).toContain("Unknown device");
  });

  it("signs out another device only after confirmation", async () => {
    expect(host.textContent).toContain("This device");
    act(() => buttonIn(host, "Sign out").click());
    expect(api.signOutOne).not.toHaveBeenCalled();

    const dialog = document.querySelector('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain("Sign out Safari · iPhone?");
    act(() => buttonIn(dialog, "Sign out").click());
    await flush();
    expect(api.signOutOne).toHaveBeenCalledWith({ path: { commandId: "cmd_phone" } });
  });

  it("signs out all other devices only after confirmation", async () => {
    act(() => buttonIn(host, "Sign out all other devices").click());
    expect(api.signOutOthers).not.toHaveBeenCalled();

    act(() => buttonIn(document.querySelector('[role="alertdialog"]')!, "Sign out all other devices").click());
    await flush();
    expect(api.signOutOthers).toHaveBeenCalledOnce();
  });

  it("offers Try again when the device list can't load", async () => {
    act(() => root.unmount());
    root = createRoot(host);
    api.list.mockReset().mockRejectedValue(new Error("offline"));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    act(() => root.render(<QueryClientProvider client={client}><AccountSessions /></QueryClientProvider>));
    await flush();

    expect(host.textContent).toContain("Couldn't load your devices.");
    expect(buttonIn(host, "Sign out all other devices").disabled).toBe(true);
    api.list.mockResolvedValue({ sessions: [session("cmd_this", true, "Chrome on Mac")], hasMore: false });
    act(() => buttonIn(host, "Try again").click());
    await flush();
    expect(host.textContent).toContain("Chrome on Mac");
  });
});
