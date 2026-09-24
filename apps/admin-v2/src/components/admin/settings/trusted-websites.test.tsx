// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  getApiV1AdminSettingsSecurity: vi.fn(),
  getApiV1AdminSettingsSecurityRuntimeSources: vi.fn(),
  postApiV1AdminSettingsSecurity: vi.fn(),
}));
vi.mock("@scalius/api-client/sdk", () => sdk);
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("../media-manager", () => ({ MediaManager: () => null }));

import { PermissionProvider } from "~/contexts/PermissionContext";
import { SaveScope, type SaveScopeState } from "../shared/SaveBar";
import { TrustedWebsitesCard } from "./AdvancedSettings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const envelope = <T,>(data: T) => Promise.resolve({ data: { success: true, data } });

describe("trusted websites", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.clearAllMocks();
    notifyManager.setNotifyFunction((callback) => { act(callback); });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    notifyManager.setNotifyFunction((callback) => callback());
  });

  it("checks each website when it's added, names the problem, and saves exactly the list shown", async () => {
    sdk.getApiV1AdminSettingsSecurity.mockImplementation(() => envelope({ cspAllowedDomains: "" }));
    sdk.getApiV1AdminSettingsSecurityRuntimeSources.mockImplementation(() => envelope([]));
    sdk.postApiV1AdminSettingsSecurity.mockImplementation(() => envelope({ message: "ok" }));
    let scope: SaveScopeState | null = null;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <PermissionProvider isSuperAdmin>
            <SaveScope render={(state) => { scope = state; return null; }}>
              <TrustedWebsitesCard />
            </SaveScope>
          </PermissionProvider>
        </QueryClientProvider>,
      );
    });
    await vi.waitFor(() => expect(sdk.getApiV1AdminSettingsSecurity).toHaveBeenCalled());
    const input = container.querySelector<HTMLInputElement>("#trusted-website")!;
    const note = () => container.querySelector("#trusted-website-note")?.textContent;
    const add = (value: string) => {
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      act(() => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    };

    add("not a url");
    expect(note()).toBe("Enter a full address like https://chat.example.com");
    add("http://chat.example.com");
    expect(note()).toBe("Use https.");
    add("chat.example.com/widget");
    expect(note()).toBe("Enter just the site address, without a path.");
    expect(container.querySelectorAll("li")).toHaveLength(0);

    add("Chat.Example.com");
    expect(note()).toBeUndefined();
    expect(container.querySelector("li")?.textContent).toBe("https://chat.example.com");

    await act(async () => { await scope!.saveAll(); });
    expect(sdk.postApiV1AdminSettingsSecurity.mock.calls[0]![0].body).toMatchObject({
      cspAllowedDomains: "https://chat.example.com",
    });
  });
});
