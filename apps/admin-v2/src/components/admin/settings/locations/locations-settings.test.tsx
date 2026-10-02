// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { translate } from "~/i18n";
import { settingsLocationsMessages } from "~/i18n/settings-locations";

const sdk = vi.hoisted(() => ({
  getApiV1AdminInventoryLocations: vi.fn(),
  getApiV1AdminInventoryByVariantIdLevels: vi.fn(),
  postApiV1AdminInventoryLocations: vi.fn(),
  patchApiV1AdminInventoryLocationsByLocationId: vi.fn(),
  postApiV1AdminInventoryLocationsByLocationIdArchive: vi.fn(),
  postApiV1AdminInventoryLocationsByLocationIdUnarchive: vi.fn(),
  postApiV1AdminInventoryLocationsByLocationIdDefault: vi.fn(),
}));
vi.mock("@scalius/api-client/sdk", () => sdk);
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { PermissionProvider } from "~/contexts/PermissionContext";
import { locationBody } from "./LocationDialog";
import { LocationsManager } from "./LocationsManager";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const t = (key: keyof typeof settingsLocationsMessages.en, vars?: Record<string, string | number>) =>
  translate(settingsLocationsMessages, key, vars);
const ok = <T,>(data: T) => Promise.resolve({ data: { success: true, data }, response: { status: 200 } });
const location = (id: string, name: string, overrides: Record<string, unknown> = {}) => ({
  id, name, code: id.toUpperCase(), kind: "warehouse", addressLine1: "House 1", addressLine2: null, city: "Dhaka",
  postalCode: null, countryCode: "BD", phone: null, isDefault: false, status: "active", position: 1, version: 1,
  onHand: 0, stockedSkus: 0, createdAt: "", updatedAt: "", ...overrides,
});

describe("location form", () => {
  const draft = {
    name: " Chattogram branch ", code: "CTG-1", kind: "store" as const, addressLine1: "", addressLine2: "",
    city: "Chattogram", postalCode: "", phone: "",
  };

  it("sends trimmed values with blank optional fields as null", () => {
    expect(locationBody(draft)).toEqual({
      body: {
        name: "Chattogram branch", code: "CTG-1", kind: "store", addressLine1: null, addressLine2: null,
        city: "Chattogram", postalCode: null, phone: null,
      },
    });
  });

  it("asks for a name and a code staff can type", () => {
    expect(locationBody({ ...draft, name: " ", code: "" })).toEqual({ errors: { name: "nameRequired", code: "codeRequired" } });
    expect(locationBody({ ...draft, code: "has space" })).toEqual({ errors: { code: "codeInvalid" } });
  });
});

describe("locations settings", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.clearAllMocks();
    notifyManager.setNotifyFunction((callback) => { act(callback); });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    sdk.getApiV1AdminInventoryLocations.mockImplementation(() => ok({
      locations: [
        location("loc_main", "Main warehouse", { isDefault: true, onHand: 40, stockedSkus: 6 }),
        location("loc_branch", "Chattogram branch", { kind: "store" }),
      ],
    }));
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
          <PermissionProvider isSuperAdmin><LocationsManager /></PermissionProvider>
        </QueryClientProvider>,
      );
    });
    await vi.waitFor(() => expect(container.textContent).toContain("Chattogram branch"));
  }

  it("lists each location with its stock and marks the default", async () => {
    await render();
    const rows = [...container.querySelectorAll("li")];
    expect(rows[0]!.textContent).toContain(t("default"));
    expect(rows[0]!.textContent).toContain(t("stock", { units: 40, skus: 6 }));
    expect(rows[1]!.textContent).not.toContain(t("default"));
    expect(rows[1]!.textContent).toContain(t("noStock"));
    expect(sdk.getApiV1AdminInventoryLocations).toHaveBeenCalledWith({ query: { includeArchived: "false" } });
  });
});
