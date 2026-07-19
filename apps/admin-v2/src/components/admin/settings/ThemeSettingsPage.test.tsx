// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_STOREFRONT_THEME_SETTINGS } from "@scalius/shared/storefront-theme";

import ThemeSettingsPage from "./ThemeSettingsPage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const getThemeWorkspaceMock = vi.hoisted(() => vi.fn());
const saveThemeDraftMock = vi.hoisted(() => vi.fn());
const publishThemeDraftMock = vi.hoisted(() => vi.fn());
const getThemeVersionsMock = vi.hoisted(() => vi.fn());
const rebaseThemeDraftMock = vi.hoisted(() => vi.fn());
const rollbackThemeMock = vi.hoisted(() => vi.fn());
const createThemePreviewSessionMock = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return {
    ...actual,
    useQuery: () => ({
      data: { storefrontUrl: "https://shop.example.test" },
      isError: false,
    }),
  };
});

vi.mock("~/lib/api-functions/settings", () => ({
  getThemeWorkspace: getThemeWorkspaceMock,
  saveThemeDraft: saveThemeDraftMock,
  publishThemeDraft: publishThemeDraftMock,
  getThemeVersions: getThemeVersionsMock,
  rebaseThemeDraft: rebaseThemeDraftMock,
  rollbackTheme: rollbackThemeMock,
  createThemePreviewSession: createThemePreviewSessionMock,
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
    getThemeWorkspaceMock.mockReset();
    saveThemeDraftMock.mockReset();
    publishThemeDraftMock.mockReset();
    getThemeVersionsMock.mockReset();
    rebaseThemeDraftMock.mockReset();
    rollbackThemeMock.mockReset();
    createThemePreviewSessionMock.mockReset();
    getThemeVersionsMock.mockResolvedValue({ versions: [] });
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
    getThemeWorkspaceMock.mockRejectedValueOnce(new Error("offline"));

    act(() =>
      root.render(
        <ThemeSettingsPage section="system" onSectionChange={() => undefined} />,
      ),
    );
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
    getThemeWorkspaceMock
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({
        published: { theme: DEFAULT_STOREFRONT_THEME_SETTINGS, revision: 4 },
        draft: {
          theme: DEFAULT_STOREFRONT_THEME_SETTINGS,
          revision: 7,
          basePublishedRevision: 4,
          updatedAt: null,
        },
      });

    act(() =>
      root.render(
        <ThemeSettingsPage section="system" onSectionChange={() => undefined} />,
      ),
    );
    await flush();

    const retry = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Retry",
    );
    expect(retry).toBeTruthy();

    act(() => retry?.click());
    await flush();

    expect(host.textContent).toContain("Published r4");
    expect(host.textContent).toContain("Draft r7 · saved");
    expect(host.textContent).toContain("Design system");
    expect(host.querySelector('select[aria-label="Headings"]')).toBeTruthy();
  });

  it("saves and then publishes one exact durable semantic draft", async () => {
    const publishedTheme = {
      ...DEFAULT_STOREFRONT_THEME_SETTINGS,
      typography: {
        ...DEFAULT_STOREFRONT_THEME_SETTINGS.typography,
        heading: "editorial" as const,
      },
    };
    getThemeWorkspaceMock.mockResolvedValueOnce({
      published: { theme: DEFAULT_STOREFRONT_THEME_SETTINGS, revision: 4 },
      draft: {
        theme: DEFAULT_STOREFRONT_THEME_SETTINGS,
        revision: 7,
        basePublishedRevision: 4,
        updatedAt: null,
      },
    });
    saveThemeDraftMock.mockResolvedValueOnce({
      theme: publishedTheme,
      revision: 8,
      basePublishedRevision: 4,
      updatedAt: null,
    });
    publishThemeDraftMock.mockResolvedValueOnce({
      published: { theme: publishedTheme, revision: 5 },
      draft: {
        theme: publishedTheme,
        revision: 9,
        basePublishedRevision: 5,
        updatedAt: null,
      },
    });

    act(() =>
      root.render(
        <ThemeSettingsPage section="system" onSectionChange={() => undefined} />,
      ),
    );
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

    expect(saveThemeDraftMock).toHaveBeenCalledWith({
      data: {
        theme: publishedTheme,
        expectedDraftRevision: 7,
        basePublishedRevision: 4,
      },
    });
    expect(publishThemeDraftMock).toHaveBeenCalledWith({
      data: {
        expectedPublishedRevision: 4,
        expectedDraftRevision: 8,
      },
    });
    expect(host.textContent).toContain("Published r5");
    expect(host.textContent).toContain("Draft r9 · saved");
  });

  it("shows an exact draft ledger, real preview controls, and immutable history", async () => {
    getThemeWorkspaceMock.mockResolvedValueOnce({
      published: { theme: DEFAULT_STOREFRONT_THEME_SETTINGS, revision: 8 },
      draft: {
        theme: DEFAULT_STOREFRONT_THEME_SETTINGS,
        revision: 11,
        basePublishedRevision: 8,
        updatedAt: null,
      },
    });
    getThemeVersionsMock.mockResolvedValueOnce({
      versions: [{
        id: "theme_8",
        theme: DEFAULT_STOREFRONT_THEME_SETTINGS,
        revision: 8,
        source: "publish",
        sourceRevision: null,
        publishedBy: null,
        createdAt: 1_700_000_000,
      }],
    });

    const onSectionChange = vi.fn();
    act(() =>
      root.render(
        <ThemeSettingsPage section="review" onSectionChange={onSectionChange} />,
      ),
    );
    await flush();

    expect(host.textContent).toContain("Draft changes");
    expect(host.textContent).toContain("Published style is current");
    expect(host.textContent).toContain("Storefront preview");
    expect(host.textContent).toContain("Published history");
    expect(host.textContent).toContain("Revision 8");
    expect(host.querySelector<HTMLInputElement>('input[value="/"]')).toBeTruthy();
    expect(host.querySelector<HTMLButtonElement>('button[aria-label="Mobile"]')).toBeTruthy();
    expect(
      host.querySelector<HTMLAnchorElement>('a[href="https://shop.example.test/"]'),
    ).toBeTruthy();
    expect(
      host.querySelector<HTMLAnchorElement>(
        'a[href="https://shop.example.test/search"]',
      ),
    ).toBeTruthy();

    const colors = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Colors",
    );
    act(() => colors?.click());
    expect(onSectionChange).toHaveBeenCalledWith("colors");
  });
});
