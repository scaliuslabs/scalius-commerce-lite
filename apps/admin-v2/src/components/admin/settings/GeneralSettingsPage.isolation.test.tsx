// @vitest-environment happy-dom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  GeneralSettingsPanel,
  GeneralSettingsSection,
} from "./general-settings-sections";

const api = vi.hoisted(() => ({ getCountries: vi.fn(), updateCountries: vi.fn(), blocker: vi.fn() }));
vi.mock("~/lib/api-functions/settings", () => ({
  getAllowedCountries: api.getCountries, updateAllowedCountries: api.updateCountries,
}));
vi.mock("@tanstack/react-router", () => ({ useBlocker: api.blocker }));

vi.mock("../header-builder", () => ({
  HeaderBuilder: () => {
    throw new Error("Header editor render failure");
  },
}));

vi.mock("../footer-builder", () => ({
  FooterBuilder: () => <div>Footer editor ready</div>,
}));

import GeneralSettingsPage from "./GeneralSettingsPage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("GeneralSettingsPage editor isolation", () => {
  let host: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    api.getCountries.mockResolvedValue({ allowedCountries: ["BD", "US", "AE"], allowedCountriesMode: "include" });
    api.blocker.mockReturnValue({ status: "idle" });
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    document.body.innerHTML = "";
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    act(() => root.unmount());
    queryClient.clear();
    consoleError.mockRestore();
    document.body.innerHTML = "";
  });

  function Harness({ initialSection = "header" }: { initialSection?: GeneralSettingsSection }) {
    const [section, setSection] = useState<GeneralSettingsSection>(initialSection);
    const [panel, setPanel] = useState<GeneralSettingsPanel | undefined>();

    return (
      <QueryClientProvider client={queryClient}><GeneralSettingsPage
        section={section}
        panel={panel}
        onSectionChange={setSection}
        onPanelChange={setPanel}
      /></QueryClientProvider>
    );
  }

  it("keeps the settings workspace usable when one editor crashes", async () => {
    await act(async () => {
      root.render(<Harness />);
    });

    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      "Header settings could not be opened.",
    );
    expect(host.textContent).toContain("General settings");
    expect(host.textContent).not.toContain("Something went wrong loading settings");

    const footerTab = Array.from(
      host.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    ).find((button) => button.textContent?.trim() === "Footer");
    if (!footerTab) throw new Error("Expected Footer settings tab");

    await act(async () => {
      footerTab.dispatchEvent(
        new MouseEvent("mousedown", {
          bubbles: true,
          cancelable: true,
          button: 0,
        }),
      );
    });

    expect(host.textContent).toContain("Footer editor ready");
    expect(host.textContent).toContain("General settings");
  });

  it("retains the country draft and guard while visiting another section", async () => {
    await act(async () => { root.render(<Harness initialSection="countries" />); });
    await vi.waitFor(() => expect(host.querySelector("#mode-exclude")).not.toBeNull());
    const mode = host.querySelector<HTMLButtonElement>("#mode-exclude")!;
    await act(async () => { mode.click(); });
    const current = {
      routeId: "/admin/settings/", fullPath: "/admin/settings/", pathname: "/admin/settings",
      search: { section: "countries" },
    };
    for (const section of ["Footer", "Customer countries"]) {
      const tab = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
        .find((button) => button.textContent?.trim() === section)!;
      await act(async () => {
        tab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
      });
      expect(host.querySelector("#mode-exclude")).toBe(mode);
      expect(mode.getAttribute("data-state")).toBe("checked");
      expect(mode.closest('[role="tabpanel"]')?.getAttribute("data-state"))
        .toBe(section === "Footer" ? "inactive" : "active");
      const guard = api.blocker.mock.calls.at(-1)![0];
      expect(guard.shouldBlockFn({ current, next: { ...current, search: { section: "footer" } } })).toBe(false);
      expect(guard.shouldBlockFn({
        current,
        next: { routeId: "/admin/orders/", fullPath: "/admin/orders/", pathname: "/admin/orders" },
      })).toBe(true);
      expect(guard.enableBeforeUnload).toBe(true);
    }
    expect(api.getCountries).toHaveBeenCalledTimes(1);
    expect(api.updateCountries).not.toHaveBeenCalled();
    const reset = Array.from(host.querySelectorAll("button")).find((button) => button.textContent?.trim() === "Reset")!;
    await act(async () => { reset.click(); });
    expect(mode.getAttribute("data-state")).toBe("unchecked");
    expect(api.blocker.mock.calls.at(-1)![0].enableBeforeUnload).toBe(false);
  });
});
