// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

    expect(host.textContent).toContain("Published colors are unavailable");
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
      .mockResolvedValueOnce({ colors: {}, revision: 4 });

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
});
