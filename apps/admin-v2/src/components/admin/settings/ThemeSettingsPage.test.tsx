// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_STOREFRONT_THEME_SETTINGS } from "@scalius/shared/storefront-theme";

import ThemeSettingsPage from "./ThemeSettingsPage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const getThemeSettingsMock = vi.hoisted(() => vi.fn());
const updateThemeSettingsMock = vi.hoisted(() => vi.fn());

vi.mock("~/lib/api-functions/settings", () => ({
  getThemeSettings: getThemeSettingsMock,
  updateThemeSettings: updateThemeSettingsMock,
}));

vi.mock("~/lib/admin-api-error", () => ({
  isAdminApiConflictError: () => false,
}));

vi.mock("~/contexts/PermissionContext", () => ({
  usePermissions: () => ({ hasPermission: () => true }),
}));

vi.mock("../shared/UnsavedChangesGuard", () => ({
  UnsavedChangesGuard: () => null,
}));

describe("ThemeSettingsPage read authority", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    document.body.innerHTML = "";
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    getThemeSettingsMock.mockReset();
    updateThemeSettingsMock.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  async function flush() {
    for (let pass = 0; pass < 3; pass += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }

  it("does not expose editable assumed defaults when the published read fails", async () => {
    getThemeSettingsMock.mockRejectedValueOnce(new Error("offline"));

    act(() => root.render(<ThemeSettingsPage />));
    await flush();

    expect(host.textContent).toContain("Published style is unavailable");
    expect(host.textContent).toContain("No values have been assumed");
    expect(host.querySelector('[aria-label$="color value"]')).toBeNull();
    expect(
      Array.from(host.querySelectorAll("button")).some(
        (button) => button.textContent?.trim() === "Publish",
      ),
    ).toBe(false);
  });

  it("recovers the authoritative editor after a successful retry", async () => {
    getThemeSettingsMock
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({
        theme: DEFAULT_STOREFRONT_THEME_SETTINGS,
        revision: 4,
      });

    act(() => root.render(<ThemeSettingsPage />));
    await flush();

    const retry = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Retry",
    );
    expect(retry).toBeTruthy();

    act(() => retry?.click());
    await flush();

    expect(host.textContent).toContain("Published · revision 4");
    expect(host.textContent).toContain("Starting palette");
    expect(host.querySelector('[aria-label$="color value"]')).toBeTruthy();
  });

  it("publishes a semantic control through the same revisioned document", async () => {
    const publishedTheme = {
      ...DEFAULT_STOREFRONT_THEME_SETTINGS,
      typography: {
        ...DEFAULT_STOREFRONT_THEME_SETTINGS.typography,
        heading: "editorial" as const,
      },
    };
    getThemeSettingsMock.mockResolvedValueOnce({
      theme: DEFAULT_STOREFRONT_THEME_SETTINGS,
      revision: 4,
    });
    updateThemeSettingsMock.mockResolvedValueOnce({
      theme: publishedTheme,
      revision: 5,
    });

    act(() => root.render(<ThemeSettingsPage />));
    await flush();

    const heading = host.querySelector<HTMLSelectElement>('select[aria-label="Headings"]');
    expect(heading).toBeTruthy();
    act(() => {
      if (!heading) return;
      heading.value = "editorial";
      heading.dispatchEvent(new Event("change", { bubbles: true }));
    });

    const publish = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Publish",
    );
    expect(publish?.disabled).toBe(false);
    act(() => publish?.click());
    await flush();

    expect(updateThemeSettingsMock).toHaveBeenCalledWith({
      data: {
        theme: publishedTheme,
        expectedRevision: 4,
      },
    });
    expect(host.textContent).toContain("Published · revision 5");
  });
});
