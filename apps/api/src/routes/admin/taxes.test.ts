import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getTaxConfiguration: vi.fn(),
  updateTaxSettings: vi.fn(),
  updateTaxRate: vi.fn(),
  invalidate: vi.fn(),
  resolveActiveDeliveryLocationNames: vi.fn(),
  getCurrencyConfig: vi.fn(),
}));

vi.mock("@scalius/core/modules/tax", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@scalius/core/modules/tax")>();
  return {
    ...actual,
    getTaxConfiguration: mocks.getTaxConfiguration,
    updateTaxSettings: mocks.updateTaxSettings,
    updateTaxRate: mocks.updateTaxRate,
  };
});

vi.mock("../../utils/cache-invalidation", () => ({
  invalidateApiAndScheduleStorefrontGroups: mocks.invalidate,
}));

vi.mock("@scalius/core/modules/orders/delivery-location-validation", () => ({
  resolveActiveDeliveryLocationNames: mocks.resolveActiveDeliveryLocationNames,
}));

vi.mock("@scalius/core/modules/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@scalius/core/modules/settings")>();
  return { ...actual, getCurrencyConfig: mocks.getCurrencyConfig };
});

import { adminTaxRoutes } from "./taxes";

const settings = {
  id: "default",
  enabled: false,
  pricesIncludeTax: false,
  taxShipping: false,
  defaultTaxClassId: null,
  shippingTaxClassId: null,
  displayLabel: "Tax",
  version: 1,
  createdAt: new Date("2026-07-10T00:00:00.000Z"),
  updatedAt: new Date("2026-07-10T00:00:00.000Z"),
};

function createApp() {
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
  app.use("*", async (c, next) => {
    c.set("db", {} as never);
    await next();
  });
  app.route("/admin/taxes", adminTaxRoutes);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getTaxConfiguration.mockResolvedValue({
    settings,
    classes: [],
    rates: [],
    jurisdictions: [
      { id: "city_1", name: "Dhaka", type: "city", parentId: null },
      { id: "zone_1", name: "Mirpur", type: "zone", parentId: "city_1" },
    ],
  });
  mocks.updateTaxSettings.mockResolvedValue({ ...settings, version: 2 });
  mocks.updateTaxRate.mockResolvedValue({
    id: "taxr_1",
    taxClassId: "taxc_1",
    name: "Renamed rate",
    rateBps: 500,
    jurisdictionType: "city",
    jurisdictionId: "city_1",
    jurisdictionLabel: "Dhaka",
    priority: 25,
    isCompound: true,
    isActive: false,
    version: 2,
    createdAt: new Date("2026-07-10T00:00:00.000Z"),
    updatedAt: new Date("2026-07-10T00:00:00.000Z"),
    deletedAt: null,
  });
  mocks.invalidate.mockResolvedValue(undefined);
  mocks.resolveActiveDeliveryLocationNames.mockResolvedValue({
    cityName: "Dhaka",
    zoneName: "Mirpur",
    areaName: null,
  });
  mocks.getCurrencyConfig.mockResolvedValue({ code: "BDT", symbol: "৳", decimalPlaces: 2 });
});

describe("Admin tax routes", () => {
  it("returns a compact tax-authorized jurisdiction tree with serialized timestamps", async () => {
    const response = await createApp().request("/api/v1/admin/taxes");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      data: {
        settings: {
          id: "default",
          createdAt: "2026-07-10T00:00:00.000Z",
          updatedAt: "2026-07-10T00:00:00.000Z",
        },
        jurisdictions: [
          { id: "city_1", name: "Dhaka", type: "city", parentId: null },
          { id: "zone_1", name: "Mirpur", type: "zone", parentId: "city_1" },
        ],
      },
    });
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });

  it("forwards the optimistic settings version and invalidates checkout reads", async () => {
    const body = {
      expectedVersion: 1,
      enabled: false,
      pricesIncludeTax: true,
      taxShipping: false,
      defaultTaxClassId: null,
      shippingTaxClassId: null,
      displayLabel: "VAT",
    };
    const response = await createApp().request("/api/v1/admin/taxes/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(200);
    expect(mocks.updateTaxSettings).toHaveBeenCalledWith(expect.anything(), body);
    expect(mocks.invalidate).toHaveBeenCalledWith(["checkout"], expect.anything());
    expect(await response.json()).toMatchObject({
      success: true,
      data: { settings: { version: 2 } },
    });
  });

  it("rejects an incomplete settings replacement before service work", async () => {
    const response = await createApp().request("/api/v1/admin/taxes/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion: 1, enabled: true }),
    });

    expect(response.status).toBe(400);
    expect(mocks.updateTaxSettings).not.toHaveBeenCalled();
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });

  it("does not inject create defaults into a partial rate update", async () => {
    const response = await createApp().request("/api/v1/admin/taxes/rates/taxr_1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion: 1, name: "Renamed rate" }),
    });

    expect(response.status).toBe(200);
    expect(mocks.updateTaxRate).toHaveBeenCalledWith(expect.anything(), "taxr_1", {
      expectedVersion: 1,
      name: "Renamed rate",
    });
    expect(mocks.updateTaxRate.mock.calls[0]?.[2]).not.toHaveProperty("priority");
    expect(mocks.updateTaxRate.mock.calls[0]?.[2]).not.toHaveProperty("isCompound");
    expect(mocks.updateTaxRate.mock.calls[0]?.[2]).not.toHaveProperty("isActive");
  });

  it("proves the active delivery parent chain before calculating a preview", async () => {
    const response = await createApp().request("/api/v1/admin/taxes/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        amount: 100,
        city: "city_1",
        zone: "zone_1",
        area: null,
      }),
    });

    expect(response.status).toBe(200);
    expect(mocks.resolveActiveDeliveryLocationNames).toHaveBeenCalledWith(
      expect.anything(),
      { city: "city_1", zone: "zone_1", area: null },
    );
  });
});
