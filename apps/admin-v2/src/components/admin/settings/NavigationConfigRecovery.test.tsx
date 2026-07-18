// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  saveHeaderConfig: vi.fn(),
  saveFooterConfig: vi.fn(),
  getGeneralSettings: vi.fn(),
}));

vi.mock("~/lib/api-functions/settings", () => ({
  saveHeaderConfig: mocks.saveHeaderConfig,
  saveFooterConfig: mocks.saveFooterConfig,
  getGeneralSettings: mocks.getGeneralSettings,
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("../footer-builder/ContentSection", () => ({
  ContentSection: () => null,
}));

vi.mock("~/hooks/use-storefront-url", () => ({
  useStorefrontUrl: () => ({
    getStorefrontPath: (path: string) => path,
  }),
}));

import { HeaderBuilder } from "../header-builder/HeaderBuilder";
import { defaultHeaderConfig } from "../header-builder/types";
import { FooterBuilder } from "../footer-builder/FooterBuilder";
import { defaultFooterConfig } from "../footer-builder/types";
import { AdminApiResponseError } from "~/lib/admin-api-error";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("navigation configuration recovery", () => {
  let host: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    document.body.innerHTML = "";
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    mocks.saveHeaderConfig.mockReset().mockResolvedValue({ revision: 2 });
    mocks.saveFooterConfig.mockReset().mockResolvedValue({ revision: 2 });
    mocks.getGeneralSettings.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    queryClient.clear();
    document.body.innerHTML = "";
  });

  function render(child: ReactNode) {
    act(() => root.render(
      <QueryClientProvider client={queryClient}>{child}</QueryClientProvider>,
    ));
  }

  it("allows an unchanged normalized header to be persisted explicitly", async () => {
    render(
      <HeaderBuilder
        activePanel="branding"
        initialConfig={{
          ...defaultHeaderConfig,
          logo: { src: "/logo.svg", alt: "Store" },
        }}
        readiness={{ state: "legacy_normalized" }}
        initialRevision={1}
      />,
    );

    const saveButton = Array.from(host.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.trim() === "Save typed format");
    if (!saveButton) throw new Error("Expected header normalization save action");
    expect(saveButton.disabled).toBe(false);

    await act(async () => saveButton.click());

    expect(mocks.saveHeaderConfig).toHaveBeenCalledTimes(1);
    expect(mocks.saveHeaderConfig).toHaveBeenCalledWith({
      data: expect.objectContaining({
        expectedRevision: 1,
        logo: { src: "/logo.svg", alt: "Store" },
      }),
    });
    expect(host.textContent).not.toContain("Save navigation update");
    expect(host.textContent).toContain("All changes saved");
    const savedButton = Array.from(
      host.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent?.trim() === "Save changes");
    expect(savedButton?.disabled).toBe(true);
  });

  it("allows an unchanged normalized footer to be persisted explicitly", async () => {
    render(
      <FooterBuilder
        activePanel="branding"
        initialConfig={defaultFooterConfig}
        readiness={{ state: "legacy_normalized" }}
        initialRevision={1}
      />,
    );

    const saveButton = Array.from(host.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.trim() === "Save typed format");
    if (!saveButton) throw new Error("Expected footer normalization save action");
    expect(saveButton.disabled).toBe(false);

    await act(async () => saveButton.click());

    expect(mocks.saveFooterConfig).toHaveBeenCalledTimes(1);
    expect(host.textContent).not.toContain("Save navigation update");
    expect(host.textContent).toContain("All changes saved");
  });

  it("locks only the invalid builder instead of exposing assumed defaults", () => {
    render(
      <HeaderBuilder
        initialConfig={defaultHeaderConfig}
        readiness={{ state: "invalid" }}
      />,
    );

    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      "Header editing locked",
    );
    expect(host.querySelector('[role="tablist"]')).toBeNull();
    expect(host.textContent).not.toContain("Save changes");
    expect(host.textContent).toContain("other settings remain available");
  });

  it("uses the canonical announcement panel key for the real tab interaction", async () => {
    const onPanelChange = vi.fn();
    const config = {
      ...defaultHeaderConfig,
      logo: { src: "/logo.svg", alt: "Store" },
    };

    render(
      <HeaderBuilder
        activePanel="branding"
        initialConfig={config}
        onPanelChange={onPanelChange}
      />,
    );

    const announcementTab = Array.from(
      host.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    ).find((button) => button.textContent?.trim() === "Announcement");
    if (!announcementTab) throw new Error("Expected Announcement tab");

    await act(async () => {
      announcementTab.dispatchEvent(
        new MouseEvent("mousedown", {
          bubbles: true,
          cancelable: true,
          button: 0,
        }),
      );
    });

    expect(onPanelChange).toHaveBeenCalledWith("announcement");

    render(
      <HeaderBuilder
        activePanel="announcement"
        initialConfig={config}
        onPanelChange={onPanelChange}
      />,
    );

    expect(announcementTab.getAttribute("data-state")).toBe("active");
    expect(host.textContent).toContain("Announcement bar");
    expect(host.textContent).toContain("Message");
  });

  it("keeps a stale header draft and rebases it onto the latest revision", async () => {
    const initialConfig = {
      ...defaultHeaderConfig,
      logo: { src: "/logo.svg", alt: "Store" },
      topBar: { text: "Original", isEnabled: true },
      contact: { phone: "1", text: "Call", isEnabled: true },
    };
    const latestConfig = {
      ...initialConfig,
      topBar: { text: "Saved elsewhere", isEnabled: false },
      contact: { phone: "2", text: "Support", isEnabled: true },
    };
    mocks.saveHeaderConfig.mockRejectedValueOnce(
      new AdminApiResponseError(
        "Header settings changed in another session.",
        409,
        "SITE_PRESENTATION_REVISION_CONFLICT",
        { section: "header", expectedRevision: 1, currentRevision: 2 },
      ),
    );
    mocks.getGeneralSettings.mockResolvedValue({
      headerConfig: latestConfig,
      footerConfig: defaultFooterConfig,
      revisions: { header: 2, footer: 1 },
      navigationReadiness: {
        header: { state: "ready" },
        footer: { state: "ready" },
      },
    });

    render(
      <HeaderBuilder
        activePanel="announcement"
        initialConfig={initialConfig}
        initialRevision={1}
      />,
    );

    const message = host.querySelector<HTMLInputElement>("#announcement-text");
    if (!message) throw new Error("Expected announcement input");
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      setValue?.call(message, "Local promo");
      message.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const save = Array.from(host.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.trim() === "Save changes");
    if (!save) throw new Error("Expected header save action");
    expect(save.disabled).toBe(false);
    await act(async () => save.click());

    expect(host.textContent).toContain("A newer version was saved elsewhere");
    expect(message.value).toBe("Local promo");

    const merge = Array.from(host.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.trim() === "Merge mine");
    if (!merge) throw new Error("Expected merge action");
    await act(async () => merge.click());

    expect(host.textContent).not.toContain("A newer version was saved elsewhere");
    expect(message.value).toBe("Local promo");
    expect(message.disabled).toBe(true);

    mocks.saveHeaderConfig.mockResolvedValueOnce({ revision: 3 });
    await act(async () => save.click());
    expect(mocks.saveHeaderConfig).toHaveBeenLastCalledWith({
      data: expect.objectContaining({
        expectedRevision: 2,
        topBar: { text: "Local promo", isEnabled: false },
        contact: latestConfig.contact,
      }),
    });
  });
});
