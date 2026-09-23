// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SecuritySettingsBuilder } from "./SecuritySettingsBuilder";

vi.mock("@/components/admin/shared/UnsavedChangesGuard", () => ({ UnsavedChangesGuard: () => null }));
vi.mock("@/contexts/PermissionContext", () => ({ usePermissions: () => ({ hasPermission: () => true }) }));
vi.mock("@/lib/api", () => ({ apiData: (result: unknown) => result }));
vi.mock("@scalius/api-client/sdk", () => ({
  getApiV1AdminSettingsSecurity: async () => ({ cspAllowedDomains: "https://storefront.example.com" }),
  postApiV1AdminSettingsSecurity: vi.fn(),
  getApiV1AdminSettingsSecurityRuntimeSources: async () => [
    {
      key: "storefront", label: "Storefront", kind: "storefront",
      source: "https://storefront.example.com", consequence: "Add the Storefront URL in Settings → Platform.",
    },
    {
      key: "r2", label: "Public media storage", kind: "media",
      source: null, consequence: "Add the Media URL in Settings → Platform.",
    },
  ],
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("SecuritySettingsBuilder", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("names where inherited addresses come from and how to add a missing one", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <SecuritySettingsBuilder />
        </QueryClientProvider>,
      );
    });
    await vi.waitFor(() => expect(host.textContent).toContain("Missing"));

    const text = host.textContent ?? "";
    expect(text).toContain("These addresses come from Settings → Platform.");
    expect(text).toContain("https://storefront.example.com");
    expect(text).toContain("Missing");
    expect(text).toContain("Add the Media URL in Settings → Platform.");
    expect(text).not.toMatch(/→ \.|the {2}section/);
    // Inherited addresses are not repeated as merchant additions.
    expect(text).toContain("No merchant-added origins.");
  });
});
