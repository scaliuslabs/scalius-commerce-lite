// @vitest-environment happy-dom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GeneralSettingsSection } from "./general-settings-sections";
import { findSettingsNavSection } from "./settings-navigation";

const api = vi.hoisted(() => ({ blocker: vi.fn(() => ({ status: "idle" })) }));
vi.mock("@tanstack/react-router", () => ({ useBlocker: api.blocker }));
vi.mock("../header-builder", () => ({
  HeaderBuilder: () => <div>Header editor ready</div>,
}));
vi.mock("../footer-builder", () => ({
  FooterBuilder: () => <div>Footer editor ready</div>,
}));
vi.mock("./MediaSettingsBuilder", () => ({
  default: () => <div>Media editor ready</div>,
}));

import GeneralSettingsPage from "./GeneralSettingsPage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("GeneralSettingsPage settings navigation", () => {
  let host: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.clearAllMocks();
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    document.body.innerHTML = "";
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    queryClient.clear();
    document.body.innerHTML = "";
  });

  function Harness({
    initialSection = "header",
  }: {
    initialSection?: GeneralSettingsSection;
  }) {
    const [section, setSection] =
      useState<GeneralSettingsSection>(initialSection);
    return (
      <QueryClientProvider client={queryClient}>
        <GeneralSettingsPage
          section={section}
          onSectionChange={setSection}
          onPanelChange={() => {}}
          isSuperAdmin
        />
      </QueryClientProvider>
    );
  }

  async function render(initialSection?: GeneralSettingsSection) {
    await act(async () => {
      root.render(<Harness initialSection={initialSection} />);
    });
  }

  function backLink() {
    return Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "All settings",
    );
  }

  it("lists every destination in the persistent settings navigation", async () => {
    await render();

    const sidebar = host.querySelector('[data-settings-nav="sidebar"]')!;
    expect(sidebar).not.toBeNull();
    expect(
      sidebar.querySelector('[data-settings-nav-section="platform"]'),
    ).not.toBeNull();
    // Destinations that used to live only in the app sidebar's settings
    // sub-menu are reachable from the same list.
    expect(
      sidebar.querySelector('a[href="/admin/settings/theme"]'),
    ).not.toBeNull();
    expect(
      sidebar.querySelector('a[href="/admin/settings/cache"]'),
    ).not.toBeNull();
  });

  it("names the open section in the page header", async () => {
    await render("media");

    const media = findSettingsNavSection("media")!;
    const header = host.querySelector("h1")!;
    expect(header.textContent).toBe(media.label);
    expect(host.textContent).toContain(media.description);
    expect(host.textContent).toContain("Media editor ready");
  });

  it("opens the settings index first on narrow widths", async () => {
    await render();

    const index = host.querySelector('[data-settings-nav="index"]');
    expect(index).not.toBeNull();
    // The section page is the second step below `lg`, so the panel column is
    // hidden until a destination is chosen.
    const panel = host
      .querySelector('[data-settings-panel="header"]')!
      .closest("div.min-w-0")!.parentElement!;
    expect(panel.className).toContain("hidden");
    expect(backLink()).toBeUndefined();
  });

  it("opens a section page from the index and returns with the back link", async () => {
    await render();

    await act(async () => {
      host
        .querySelector<HTMLButtonElement>(
          '[data-settings-nav="index"] [data-settings-nav-section="footer"]',
        )!
        .click();
    });

    expect(host.querySelector('[data-settings-nav="index"]')).toBeNull();
    expect(host.textContent).toContain("Footer editor ready");
    expect(host.querySelector("h1")!.textContent).toBe(
      findSettingsNavSection("footer")!.label,
    );

    const back = backLink();
    expect(back).toBeDefined();
    await act(async () => back!.click());

    expect(host.querySelector('[data-settings-nav="index"]')).not.toBeNull();
  });

  it("opens a `?section=` deep link directly on its section page", async () => {
    await render("media");

    expect(host.querySelector('[data-settings-nav="index"]')).toBeNull();
    expect(backLink()).toBeDefined();
  });

  it("keeps a visited editor mounted after moving to another section", async () => {
    await render("media");
    expect(host.textContent).toContain("Media editor ready");

    await act(async () => {
      host
        .querySelector<HTMLButtonElement>(
          '[data-settings-nav="sidebar"] [data-settings-nav-section="footer"]',
        )!
        .click();
    });

    const mediaPanel = host.querySelector('[data-settings-panel="media"]')!;
    expect(mediaPanel.getAttribute("data-state")).toBe("inactive");
    expect(mediaPanel.textContent).toContain("Media editor ready");
    expect(
      host
        .querySelector('[data-settings-panel="footer"]')!
        .getAttribute("data-state"),
    ).toBe("active");
  });
});
