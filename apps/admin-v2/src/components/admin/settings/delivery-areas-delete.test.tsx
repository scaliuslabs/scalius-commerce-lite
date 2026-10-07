// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  getApiV1AdminSettingsDeliveryLocations: vi.fn(),
  getApiV1AdminSettingsDeliveryLocationsCountries: vi.fn(),
  getApiV1AdminSettingsDeliveryProviders: vi.fn(),
  deleteApiV1AdminSettingsDeliveryLocations: vi.fn(),
  deleteApiV1AdminSettingsDeliveryLocationsAll: vi.fn(),
  deleteApiV1AdminSettingsDeliveryLocationsById: vi.fn(),
  postApiV1AdminSettingsDeliveryLocations: vi.fn(),
  putApiV1AdminSettingsDeliveryLocationsById: vi.fn(),
}));
vi.mock("@scalius/api-client/sdk", () => sdk);
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({ children, className }: { children: React.ReactNode; className?: string }) => <a href="/admin/apps/scalius.bangladesh/pages/places" className={className}>{children}</a>,
}));

import { PermissionProvider } from "~/contexts/PermissionContext";
import { DeliveryAreasManager } from "./DeliveryAreas";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ok = <T,>(data: T) => Promise.resolve({ data: { success: true, data }, response: { status: 200 } });
const city = (id: string, name: string, descendants: Record<string, number> = {}) => ({
  id, name, countryCode: "BD", level: 1, parentId: null, sourceKey: null, source: null,
  externalIds: {}, metadata: {}, isActive: true, sortOrder: 0, descendants,
});
const cities = [
  city("dhaka", "Dhaka", { "2": 2, "3": 5 }),
  city("ctg", "Chattogram"),
  city("sylhet", "Sylhet"),
];

describe("deleting selected places", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.clearAllMocks();
    notifyManager.setNotifyFunction((callback) => { act(callback); });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    sdk.getApiV1AdminSettingsDeliveryLocations.mockImplementation(() =>
      ok({ locations: cities, pagination: { page: 1, limit: 20, total: 3, totalPages: 1 } }));
    sdk.getApiV1AdminSettingsDeliveryLocationsCountries.mockImplementation(() => ok({ countries: [{ countryCode: "BD", places: 10 }] }));
    sdk.getApiV1AdminSettingsDeliveryProviders.mockImplementation(() => ok({ providers: [] }));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = "";
    notifyManager.setNotifyFunction((callback) => callback());
  });

  async function render() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <PermissionProvider isSuperAdmin><DeliveryAreasManager /></PermissionProvider>
        </QueryClientProvider>,
      );
    });
  }

  async function select(names: string[]) {
    await render();
    await vi.waitFor(() => expect(container.textContent).toContain("Chattogram"));
    for (const name of names) {
      const row = [...container.querySelectorAll("li")].find((item) => item.textContent?.includes(name))!;
      await act(async () => row.querySelector<HTMLButtonElement>('[role="checkbox"]')!.click());
    }
    const remove = [...container.querySelectorAll("button")].find((button) => button.textContent === "Delete")!;
    await act(async () => remove.click());
    return vi.waitFor(() => document.querySelector("[role=alertdialog]")!.textContent!);
  }

  it("names one place and what is under it", async () => {
    const dialog = await select(["Dhaka"]);
    expect(dialog).toContain("Delete “Dhaka”?");
    expect(dialog).toContain("Dhaka has 2 thanas and 5 areas. They'll be deleted too.");
    expect(dialog).not.toMatch(/Delete 1/);
  });

  it("counts several places in a plural title", async () => {
    const dialog = await select(["Chattogram", "Sylhet"]);
    expect(dialog).toContain("Delete 2 places?");
    expect(dialog).toContain("This can't be undone.");
  });

  it("lists Bangladesh by its own levels and reads one country and level", async () => {
    await render();
    await vi.waitFor(() => expect(container.textContent).toContain("Chattogram"));
    const tabs = [...container.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent);
    expect(tabs).toEqual(["Cities", "Thanas", "Areas"]);
    expect(sdk.getApiV1AdminSettingsDeliveryLocations).toHaveBeenCalledWith(expect.objectContaining({
      query: expect.objectContaining({ country: "BD", level: 1, page: 1 }),
    }));
  });

  it("shows another country's generic levels and its empty state", async () => {
    sdk.getApiV1AdminSettingsDeliveryLocationsCountries.mockImplementation(() => ok({ countries: [{ countryCode: "IN", places: 0 }] }));
    sdk.getApiV1AdminSettingsDeliveryLocations.mockImplementation(() =>
      ok({ locations: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 0 } }));
    await render();
    await vi.waitFor(() => expect(container.textContent).toContain("No places in India yet. Add its regions first."));
    const tabs = [...container.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent);
    expect(tabs).toEqual(["Regions", "Cities", "Districts", "Areas"]);
    expect(container.textContent).not.toContain("Import Bangladesh locations");
  });
});
