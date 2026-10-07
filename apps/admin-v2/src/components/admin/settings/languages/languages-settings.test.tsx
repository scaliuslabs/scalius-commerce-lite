// @vitest-environment happy-dom
/**
 * Settings › Languages (docs/MARKETS-DESIGN.md D9): a store with one language
 * sees a sentence and one way to add another; machine translation and the
 * status table appear with a second language.
 */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  getApiV1AdminSettingsLanguages: vi.fn(),
  postApiV1AdminSettingsLanguages: vi.fn(),
  patchApiV1AdminSettingsLanguagesByLocale: vi.fn(),
  deleteApiV1AdminSettingsLanguagesByLocale: vi.fn(),
  getApiV1AdminSettingsProviders: vi.fn(),
}));
vi.mock("@scalius/api-client/sdk", () => sdk);
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@tanstack/react-router", () => ({
  useLocation: ({ select }: { select?: (location: { hash: string }) => unknown } = {}) => (select ? select({ hash: "" }) : { hash: "" }),
  Link: ({ children, to, search: _search, ...props }: { children: ReactNode; to: string; search?: unknown }) => <a href={to} {...props}>{children}</a>,
}));

import { PermissionProvider } from "~/contexts/PermissionContext";
import { LanguagesSettings } from "./LanguagesSettings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const envelope = <T,>(data: T) => Promise.resolve({ data: { success: true, data } });
const english = { locale: "en", published: true, isDefault: true, presences: [""], translatedResources: 0 };
const bangla = { locale: "bn", published: false, isDefault: false, presences: [], translatedResources: 3 };

describe("languages settings", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.clearAllMocks();
    notifyManager.setNotifyFunction((callback) => { act(callback); });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    sdk.getApiV1AdminSettingsProviders.mockImplementation(() => envelope({ items: [] }));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = "";
    notifyManager.setNotifyFunction((callback) => callback());
  });

  async function render(items: unknown[]) {
    sdk.getApiV1AdminSettingsLanguages.mockImplementation(() => envelope({ items }));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <PermissionProvider isSuperAdmin><LanguagesSettings /></PermissionProvider>
        </QueryClientProvider>,
      );
    });
  }

  it("shows one language as a sentence with one way to add another", async () => {
    await render([english]);
    await vi.waitFor(() => expect(container.textContent).toContain("Your store is in English."));
    expect(container.querySelector("table")).toBeNull();
    expect(container.textContent).not.toContain("Machine translation");
    expect([...container.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["Add language"]);
  });

  it("shows the status table and machine translation with a second language", async () => {
    await render([english, bangla]);
    await vi.waitFor(() => expect(container.querySelectorAll("tbody tr")).toHaveLength(2));
    expect(container.textContent).toContain("Machine translation");
    expect(container.textContent).toContain("Unpublished");
    expect(container.textContent).toContain("Not used yet");
  });
});
