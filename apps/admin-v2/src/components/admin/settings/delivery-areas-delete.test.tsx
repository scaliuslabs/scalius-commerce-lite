// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  getApiV1AdminSettingsDeliveryLocations: vi.fn(),
  getApiV1AdminSettingsDeliveryLocationsImportPathaoStatus: vi.fn(),
  getApiV1AdminSettingsDeliveryProviders: vi.fn(),
  deleteApiV1AdminSettingsDeliveryLocations: vi.fn(),
  deleteApiV1AdminSettingsDeliveryLocationsAll: vi.fn(),
  deleteApiV1AdminSettingsDeliveryLocationsById: vi.fn(),
  deleteApiV1AdminSettingsDeliveryLocationsImportPathao: vi.fn(),
  postApiV1AdminSettingsDeliveryLocations: vi.fn(),
  postApiV1AdminSettingsDeliveryLocationsImportPathao: vi.fn(),
  putApiV1AdminSettingsDeliveryLocationsById: vi.fn(),
}));
vi.mock("@scalius/api-client/sdk", () => sdk);
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { PermissionProvider } from "~/contexts/PermissionContext";
import { DeliveryAreasManager } from "./DeliveryAreas";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ok = <T,>(data: T) => Promise.resolve({ data: { success: true, data }, response: { status: 200 } });
const city = (id: string, name: string, descendants = { zones: 0, areas: 0 }) => ({
  id, name, type: "city", parentId: null, externalIds: {}, metadata: {}, isActive: true, sortOrder: 0, descendants,
});
const cities = [
  city("dhaka", "Dhaka", { zones: 2, areas: 5 }),
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
    sdk.getApiV1AdminSettingsDeliveryLocationsImportPathaoStatus.mockImplementation(() => ok({ status: "idle" }));
    sdk.getApiV1AdminSettingsDeliveryProviders.mockImplementation(() => ok({ providers: [] }));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = "";
    notifyManager.setNotifyFunction((callback) => callback());
  });

  async function select(names: string[]) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <PermissionProvider isSuperAdmin><DeliveryAreasManager /></PermissionProvider>
        </QueryClientProvider>,
      );
    });
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
});
