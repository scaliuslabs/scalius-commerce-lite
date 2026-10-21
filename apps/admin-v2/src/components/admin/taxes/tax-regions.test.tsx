// @vitest-environment happy-dom
/**
 * Settings → Taxes by region (MARKETS-DESIGN step 3c): the countries the
 * store collects tax in, and one country's page with its rates, its regions
 * (Bangladesh: cities, thanas and areas; elsewhere: states or postal codes)
 * and the rates a region adds to the larger area's.
 */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  getApiV1AdminTaxes: vi.fn(),
  getApiV1AdminTaxesRegionsById: vi.fn(),
  getApiV1AdminTaxesSettings: vi.fn(),
  postApiV1AdminTaxesClasses: vi.fn(),
  postApiV1AdminTaxesRegions: vi.fn(),
  putApiV1AdminTaxesRegionsById: vi.fn(),
  deleteApiV1AdminTaxesRegionsById: vi.fn(),
  postApiV1AdminTaxesRates: vi.fn(),
  putApiV1AdminTaxesRatesById: vi.fn(),
  deleteApiV1AdminTaxesRatesById: vi.fn(),
  getApiV1AdminSettingsProviders: vi.fn(),
  getApiV1AddressRules: vi.fn(),
  getApiV1AddressRulesByCountryCode: vi.fn(),
}));
const navigate = vi.hoisted(() => vi.fn());
vi.mock("@scalius/api-client/sdk", () => sdk);
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
  useLocation: ({ select }: { select?: (location: { hash: string }) => unknown } = {}) => (select ? select({ hash: "" }) : { hash: "" }),
  Link: ({ children, to, params: _params, hash: _hash, ...props }: { children: ReactNode; to: string; params?: unknown; hash?: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

import { PermissionProvider } from "~/contexts/PermissionContext";
import { SaveScope } from "../shared/SaveBar";
import { TaxRegionPage } from "./TaxRegionPage";
import { TaxCollectionCard, TaxRegionsCard } from "./TaxesSettings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const envelope = <T,>(data: T) => Promise.resolve({ data: { success: true, data } });
const stamp = "2026-10-07T00:00:00.000Z";
const region = (id: string, countryCode: string, extra: Record<string, unknown> = {}) => ({
  id, countryCode, kind: "country", adminArea: null, postalPrefix: null, placeType: null, placeId: null, placeName: null,
  providerId: null, rateCount: 0, version: 1, createdAt: stamp, updatedAt: stamp, ...extra,
});
const rate = (id: string, taxRegionId: string, extra: Record<string, unknown> = {}) => ({
  id, taxClassId: "taxc_std", taxRegionId, name: id, rateBps: 1_500, priority: 0, isCompound: false, combinable: false,
  isActive: true, version: 1, createdAt: stamp, updatedAt: stamp, ...extra,
});
const regions = [
  region("txreg_bd", "BD", { rateCount: 1 }),
  region("txreg_bd_dhaka", "BD", { kind: "place", placeType: "city", placeId: "city_dhaka", placeName: "Dhaka", rateCount: 1 }),
  region("txreg_us", "US", { providerId: "acme.tax:avalara" }),
  region("txreg_us_ca", "US", { kind: "admin_area", adminArea: "CA", rateCount: 1 }),
];
const rates = [
  rate("VAT", "txreg_bd"),
  rate("Dhaka levy", "txreg_bd_dhaka", { rateBps: 200, combinable: true }),
  rate("California", "txreg_us_ca", { rateBps: 725 }),
];
const configuration = {
  settings: {
    id: "default", enabled: true, taxShipping: false, defaultTaxClassId: "taxc_std", shippingTaxClassId: null,
    displayLabel: "VAT", providerId: "system", version: 2, createdAt: stamp, updatedAt: stamp,
  },
  classes: [{ id: "taxc_std", name: "Standard", description: null, isExempt: false, version: 1, createdAt: stamp, updatedAt: stamp, deletedAt: null }],
  regions,
  rates,
  jurisdictions: [],
};

describe("tax regions settings", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.clearAllMocks();
    notifyManager.setNotifyFunction((callback) => { act(callback); });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    sdk.getApiV1AdminTaxes.mockImplementation(() => envelope(configuration));
    sdk.getApiV1AdminTaxesRegionsById.mockImplementation(({ path: { id } }: { path: { id: string } }) => {
      const country = regions.find((each) => each.id === id)!;
      const subRegions = regions.filter((each) => each.countryCode === country.countryCode && each.kind !== "country");
      const ids = new Set([id, ...subRegions.map((each) => each.id)]);
      return envelope({ region: country, subRegions, rates: rates.filter((each) => ids.has(each.taxRegionId)) });
    });
    sdk.getApiV1AdminSettingsProviders.mockImplementation(() => envelope({
      providers: [{
        id: "acme.tax:avalara", kind: "tax", name: "Avalara", appName: "Acme Tax", pluginId: "acme.tax",
        readiness: { usable: true }, canTestConnection: false,
      }],
    }));
    sdk.getApiV1AddressRules.mockImplementation(() => envelope({ countries: ["BD", "FR", "US"] }));
    sdk.getApiV1AddressRulesByCountryCode.mockImplementation(() => envelope({
      adminAreas: [{ code: "CA", name: "California" }, { code: "NY", name: "New York" }],
    }));
    sdk.postApiV1AdminTaxesRates.mockImplementation(({ body }: { body: Record<string, unknown> }) => envelope({ taxRate: { ...rate("new", "x"), ...body } }));
    sdk.putApiV1AdminTaxesRegionsById.mockImplementation(({ body }: { body: Record<string, unknown> }) => envelope({ region: { ...regions[2], ...body } }));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = "";
    notifyManager.setNotifyFunction((callback) => callback());
  });

  async function render(children: ReactNode) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <PermissionProvider isSuperAdmin>
            <SaveScope render={() => null}>{children}</SaveScope>
          </PermissionProvider>
        </QueryClientProvider>,
      );
    });
  }

  it("lists each country the store collects tax in with its rates, regions and service", async () => {
    await render(<TaxRegionsCard />);
    await vi.waitFor(() => expect(container.querySelectorAll("tbody tr")).toHaveLength(2));
    const [bd, us] = [...container.querySelectorAll("tbody tr")].map((row) => [...row.querySelectorAll("td")].map((cell) => cell.textContent));
    expect(bd).toEqual(["Bangladesh", "2", "1", "Scalius tax rates"]);
    await vi.waitFor(() => expect(container.querySelectorAll("tbody tr")[1]!.textContent).toContain("Avalara"));
    expect(us!.slice(0, 3)).toEqual(["United States", "1", "1"]);
    expect(container.textContent).toContain("Tax is collected only in the countries you add.");
  });

  it("starts a store with no tax group from one button, and chooses the group it makes", async () => {
    const standard = { id: "taxc_new", name: "Standard", description: null, isExempt: false, version: 1, createdAt: stamp, updatedAt: stamp, deletedAt: null };
    let made = false;
    const empty = { ...configuration, settings: { ...configuration.settings, enabled: false, defaultTaxClassId: null }, classes: [], regions: [], rates: [] };
    sdk.getApiV1AdminTaxes.mockImplementation(() => envelope(made ? { ...empty, classes: [standard] } : empty));
    sdk.getApiV1AdminTaxesSettings.mockImplementation(() => envelope({ settings: empty.settings }));
    sdk.postApiV1AdminTaxesClasses.mockImplementation(() => {
      made = true;
      return envelope({ taxClass: standard });
    });
    await render(<TaxCollectionCard />);
    await vi.waitFor(() => expect(container.textContent).toContain("Start with one group for all your products."));
    const start = [...container.querySelectorAll("button")].find((button) => button.textContent === "Create Standard group")!;
    await act(async () => { start.click(); });
    await vi.waitFor(() => expect(sdk.postApiV1AdminTaxesClasses).toHaveBeenCalledWith({ body: { name: "Standard", isExempt: false } }));
    // The group exists now, so the one-button start is gone and the default group names it.
    await vi.waitFor(() => expect(container.textContent).not.toContain("Start with one group for all your products."));
    expect(container.querySelector("#tax-default-group")?.textContent).toContain("Standard");
  });

  it("keeps what depends on collecting tax off until Collect tax is ticked", async () => {
    const off = { ...configuration.settings, enabled: false };
    sdk.getApiV1AdminTaxes.mockImplementation(() => envelope({ ...configuration, settings: off }));
    sdk.getApiV1AdminTaxesSettings.mockImplementation(() => envelope({ settings: off }));
    await render(<TaxCollectionCard />);
    await vi.waitFor(() => expect(container.querySelector("#tax-default-group")).not.toBeNull());
    // The checkbox itself stays usable; the group, the delivery checkbox and the checkout name wait.
    const switches = [...container.querySelectorAll<HTMLButtonElement>("button[role=checkbox]")];
    expect(switches.map((entry) => entry.disabled)).toEqual([false, true]);
    expect(container.querySelector<HTMLButtonElement>("#tax-default-group")!.disabled).toBe(true);
    expect(container.querySelector<HTMLInputElement>("#tax-label")!.disabled).toBe(true);
    // Turning tax on frees them in place.
    await act(async () => { switches[0]!.click(); });
    expect(container.querySelector<HTMLButtonElement>("#tax-default-group")!.disabled).toBe(false);
    expect(container.querySelector<HTMLInputElement>("#tax-label")!.disabled).toBe(false);
    expect([...container.querySelectorAll<HTMLButtonElement>("button[role=checkbox]")].map((entry) => entry.disabled)).toEqual([false, false]);
  });

  it("shows a country's rates with where each applies, and its places", async () => {
    await render(<TaxRegionPage regionId="txreg_bd" />);
    await vi.waitFor(() => expect(container.textContent).toContain("Dhaka levy"));
    expect(container.textContent).toContain("15% · All of Bangladesh · Standard");
    expect(container.textContent).toContain("2% · Dhaka · Standard");
    expect(container.textContent).toContain("Cities, thanas and areas that have their own rates.");
    expect(container.textContent).toContain("Stop collecting tax in Bangladesh");
  });

  it("says an app calculates a country's tax and saves the country's service", async () => {
    await render(<TaxRegionPage regionId="txreg_us" />);
    await vi.waitFor(() => expect(container.textContent).toContain("Avalara calculates tax in United States, so these rates aren't used."));
    expect(container.textContent).toContain("States, provinces or postal codes that have their own rates.");
    expect(container.textContent).toContain("California");
    expect(container.textContent).toContain("Who calculates tax for addresses in United States.");
  });
});
