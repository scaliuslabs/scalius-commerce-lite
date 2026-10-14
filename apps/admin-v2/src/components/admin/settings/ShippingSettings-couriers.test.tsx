// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  getApiV1AdminSettingsDeliveryProviders: vi.fn(),
  getApiV1AdminSettingsProviders: vi.fn(),
  getApiV1AdminSettingsPlatform: vi.fn(),
  putApiV1AdminSettingsDeliveryProviders: vi.fn(),
  postApiV1AdminSettingsProvidersByIdTest: vi.fn(),
  postApiV1AdminSettingsDeliveryProvidersById: vi.fn(),
  deleteApiV1AdminSettingsDeliveryProvidersById: vi.fn(),
}));
vi.mock("@scalius/api-client/sdk", () => sdk);
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({ children }: { children: React.ReactNode }) => <a href="/admin/apps/acme.parcel">{children}</a>,
}));

import { PermissionProvider } from "~/contexts/PermissionContext";
import { SaveScope } from "../shared/SaveBar";
import { CouriersCard } from "./ShippingSettings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const envelope = <T,>(data: T) => Promise.resolve({ data: { success: true, data } });
const COURIER_ID = "acme.parcel:parcel";

function appCourier(readiness: Record<string, unknown> = {}) {
  return {
    id: COURIER_ID,
    kind: "courier",
    pluginId: "acme.parcel",
    appName: "Acme Parcel",
    appIcon: "/api/v1/admin/apps/acme.parcel/assets/icon?v=1111111111111111",
    icon: "/api/v1/admin/apps/acme.parcel/assets/provider-parcel?v=1111111111111111",
    name: "Acme Parcel",
    operations: ["createShipment", "trackShipment", "verifyWebhook", "testConnection"],
    canTestConnection: true,
    readiness: { configured: true, enabled: true, usable: true, missingFields: [], credentialErrors: [], ...readiness },
    environment: "live",
  };
}

function courierRow(isActive: boolean, ready: boolean, overrides: Record<string, unknown> = {}) {
  return {
    id: "prov_parcel",
    name: "Acme Parcel",
    type: COURIER_ID,
    courierName: "Acme Parcel",
    requiredLocations: [],
    canFindShipment: false,
    countries: "any",
    isActive,
    readiness: {
      status: ready ? "ready" : "incomplete",
      lifecycle: ready ? "active" : "draft",
      configured: ready,
      tested: ready,
      active: ready && isActive,
      canCreateShipment: ready && isActive,
      issues: [],
      activationBlockers: ready ? [] : [{ source: "config", key: "settings.secret", label: "secret", message: "Complete Acme Parcel's settings: secret." }],
    },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

const button = (label: string) =>
  [...document.querySelectorAll("button")].find((element) => element.textContent?.trim() === label);

describe("couriers are apps", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.clearAllMocks();
    notifyManager.setNotifyFunction((callback) => { act(callback); });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    sdk.getApiV1AdminSettingsPlatform.mockImplementation(() => envelope({ apiUrl: "https://api.shop.test" }));
    sdk.postApiV1AdminSettingsProvidersByIdTest.mockImplementation(() => envelope({ ok: true, message: "Acme Parcel account connected." }));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = "";
    notifyManager.setNotifyFunction((callback) => callback());
  });

  async function openCourier(row: ReturnType<typeof courierRow>, app: ReturnType<typeof appCourier>, expected = "This courier's keys and options are kept, encrypted, with its app.") {
    sdk.getApiV1AdminSettingsDeliveryProviders.mockImplementation(() =>
      envelope({ providers: [row], pagination: { page: 1, limit: 10, hasMore: false } }));
    sdk.getApiV1AdminSettingsProviders.mockImplementation(() => envelope({ providers: [app] }));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <PermissionProvider isSuperAdmin>
            <SaveScope render={() => null}>
              <CouriersCard />
            </SaveScope>
          </PermissionProvider>
        </QueryClientProvider>,
      );
    });
    await vi.waitFor(() => expect(container.textContent).toContain(row.name));
    const rowButton = [...container.querySelectorAll("button")].find((element) => element.textContent?.includes(row.name));
    await act(async () => rowButton!.click());
    await vi.waitFor(() => expect(document.body.textContent).toContain(expected));
  }

  it("sets up a ready courier app through the app: no keys here, its update link, its connection test", async () => {
    await openCourier(courierRow(true, true), appCourier());

    expect(document.body.textContent).toContain("Acme Parcel is ready to book deliveries.");
    // The courier's own mark, from its app's listing.
    expect(container.querySelector("img")?.getAttribute("src")).toBe("/api/v1/admin/apps/acme.parcel/assets/provider-parcel?v=1111111111111111");
    await vi.waitFor(() => expect(document.querySelector<HTMLInputElement>("#courier-webhook-url")?.value)
      .toBe("https://api.shop.test/api/v1/webhooks/couriers/acme.parcel:parcel"));
    expect(document.querySelector("#courier-environment")).toBeNull();
    expect(document.querySelector("#courier-apiKey")).toBeNull();
    expect(document.querySelector("#courier-webhook-key")).toBeNull();

    await act(async () => button("Test connection")!.click());
    await vi.waitFor(() => expect(sdk.postApiV1AdminSettingsProvidersByIdTest).toHaveBeenCalledWith({ path: { id: COURIER_ID } }));
    expect(sdk.postApiV1AdminSettingsDeliveryProvidersById).not.toHaveBeenCalled();
  });

  it("keeps a courier app that is not ready switched off and says what its app needs", async () => {
    await openCourier(courierRow(false, false), appCourier({ configured: false, usable: false, missingFields: ["secret"] }));

    expect(document.body.textContent).toContain("Complete Acme Parcel's settings: secret.");
    expect(document.querySelector<HTMLButtonElement>("button[role='switch']")?.disabled).toBe(true);
  });
});
