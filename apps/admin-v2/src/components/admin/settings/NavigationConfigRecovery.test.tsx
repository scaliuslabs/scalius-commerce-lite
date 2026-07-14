// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  saveHeaderConfig: vi.fn(),
  saveFooterConfig: vi.fn(),
}));

vi.mock("~/lib/api-functions/settings", () => ({
  saveHeaderConfig: mocks.saveHeaderConfig,
  saveFooterConfig: mocks.saveFooterConfig,
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
    mocks.saveHeaderConfig.mockReset().mockResolvedValue({});
    mocks.saveFooterConfig.mockReset().mockResolvedValue({});
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
      />,
    );

    const saveButton = Array.from(host.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.trim() === "Save typed format");
    if (!saveButton) throw new Error("Expected header normalization save action");
    expect(saveButton.disabled).toBe(false);

    await act(async () => saveButton.click());

    expect(mocks.saveHeaderConfig).toHaveBeenCalledTimes(1);
    expect(mocks.saveHeaderConfig).toHaveBeenCalledWith({
      data: expect.objectContaining({ logo: { src: "/logo.svg", alt: "Store" } }),
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
});
