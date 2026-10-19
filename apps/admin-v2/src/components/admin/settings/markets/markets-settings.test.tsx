// @vitest-environment happy-dom
/**
 * Settings › Markets (docs/MARKETS-DESIGN.md D4): the list, and one market's
 * page saving under its revision. The primary (backup) market keeps the root
 * URL and owns the price format; another market sells at a subfolder, behind
 * "Web address and handle"; each country belongs to one market.
 */
import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  getApiV1AdminSettingsMarkets: vi.fn(),
  getApiV1AdminSettingsMarketsById: vi.fn(),
  patchApiV1AdminSettingsMarketsById: vi.fn(),
  postApiV1AdminSettingsMarkets: vi.fn(),
  deleteApiV1AdminSettingsMarketsById: vi.fn(),
  getApiV1AdminSettingsMarketsCurrencies: vi.fn(),
  getApiV1AdminSettingsLanguages: vi.fn(),
  getApiV1AdminSettingsProviders: vi.fn(),
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
import { SaveScope, type SaveScopeState } from "../../shared/SaveBar";
import { MarketCountryPicker } from "./MarketCountryPicker";
import { MarketEditor } from "./MarketEditor";
import { MarketsList } from "./MarketsList";
import {
  countriesTakenByOthers,
  marketForm,
  marketFormProblems,
  marketUpdateBody,
  adjustedPricePreview,
  endingChoices,
  roundingChoices,
  presencePath,
  withSubfolder,
} from "./market-form";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const envelope = <T,>(data: T) => Promise.resolve({ data: { success: true, data } });
const backup = {
  id: "mkt_backup", handle: "bangladesh", name: "Bangladesh", status: "active" as const, isBackup: true, revision: 3,
  countries: ["BD"], presence: { value: "", locale: "bn" }, currencyCode: "BDT", shopCurrencyCode: "BDT", ownCurrency: false, priceIncrementMinor: 100,
  fxRateAsOf: null as string | null, fxLockMinutes: 30, fxRateSource: "manual",
  priceIncrementInherited: false, pricesIncludeTax: true, hasOrders: true,
  priceMode: "fixed" as "fixed" | "fx", fxRate: null as string | null, priceAdjustmentPercent: 0, priceRounding: null as number | null, priceEnding: null as number | null,
  createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
};
/** An exchange rate app's provider, as `GET /admin/settings/providers?kind=fx` lists it. */
const dailyRates = {
  id: "acme.rates:daily", kind: "fx", pluginId: "acme.rates", appName: "Acme rates", appIcon: null, icon: null, name: "Daily rates",
  operations: ["rates"], canTestConnection: false,
  readiness: { configured: true, enabled: true, usable: true, missingFields: [], credentialErrors: [] }, environment: "unknown", connection: { status: "none", testedAt: null, message: null },
};
const india = {
  ...backup, id: "mkt_in", handle: "india", name: "India", status: "draft" as const, isBackup: false, revision: 1,
  countries: ["IN", "NP"], presence: null, priceIncrementInherited: true, hasOrders: false,
};

describe("market form", () => {
  it("saves the backup market's root language and price increment, never a status or subfolder", () => {
    const form = marketForm(backup);
    expect(presencePath(form)).toBe("/");
    expect(marketUpdateBody({ ...form, priceIncrementMinor: 1, locale: "en" }, 3)).toEqual({
      expectedRevision: 3, name: "Bangladesh", handle: "bangladesh", countries: ["BD"],
      presence: { value: "", locale: "en" }, priceIncrementMinor: 1, pricesIncludeTax: true,
    });
  });

  it("saves another market's subfolder as language and country code, without an increment", () => {
    const form = withSubfolder(marketForm(india), true);
    expect(form).toMatchObject({ subfolder: true, suffix: "in", locale: "en" });
    expect(presencePath(form)).toBe("/en-in");
    expect(marketUpdateBody({ ...form, status: "active" }, 1)).toEqual({
      expectedRevision: 1, name: "India", handle: "india", status: "active", countries: ["IN", "NP"],
      presence: { value: "en-in", locale: "en" }, pricesIncludeTax: true,
      currencyCode: null, fxRate: null,
      priceMode: "fixed", priceAdjustmentPercent: 0, priceRounding: null, priceEnding: null,
    });
    expect(marketUpdateBody(withSubfolder(form, false), 1).presence).toBeNull();
    expect(marketForm({ ...india, presence: { value: "bn-in", locale: "bn" } })).toMatchObject({ subfolder: true, suffix: "in", locale: "bn" });
  });

  it("saves adjusted prices and previews them with the shared FX rounding", () => {
    const form = { ...marketForm({ ...india, priceMode: "fx", priceAdjustmentPercent: 10, priceRounding: 10, priceEnding: 9 }), priceIncrementMinor: 100 };
    expect(form).toMatchObject({ priceMode: "fx", priceAdjustmentPercent: 10, priceRoundingMinor: 1_000, priceEndingMinor: 900 });
    expect(marketUpdateBody(form, 1)).toMatchObject({ priceMode: "fx", priceAdjustmentPercent: 10, priceRounding: 10, priceEnding: 9 });
    // ৳1,299 × 1.10 = ৳1,428.90 → up to ৳1,430 → ending 9: ৳1,429.
    expect(adjustedPricePreview(form, 100, [129_900])).toEqual([{ base: 129_900, adjusted: 142_900 }]);
    expect(roundingChoices("BDT", 100)).toEqual([100, 500, 1_000, 5_000, 10_000]);
    expect(endingChoices(1_000, 100)).toEqual([900]);
    expect(endingChoices(10_000, 100)).toEqual([9_900, 9_500, 9_000]);
    expect(marketFormProblems({ ...form, priceAdjustmentPercent: -100 })).toEqual({ adjustment: "adjustmentInvalid" });
    expect(adjustedPricePreview({ ...form, priceMode: "fixed" }, 100, [129_900])).toEqual([]);
  });

  it("sells a market in its own currency at the merchant's rate and previews converted prices", () => {
    const form = { ...marketForm(india), currencyCode: "GBP", fxRate: "0.0068", priceMode: "fx" as const, priceRoundingMinor: 100, priceEndingMinor: 99 };
    expect(marketUpdateBody(form, 1)).toMatchObject({ currencyCode: "GBP", fxRate: "0.0068", fxLockMinutes: 30, priceMode: "fx", priceRounding: 1, priceEnding: 0.99 });
    // ৳1,299 × 0.0068 = £8.8332 → up to £9 → ending .99: £8.99.
    expect(adjustedPricePreview(form, 1, [129_900])).toEqual([{ base: 129_900, adjusted: 899 }]);
    expect(marketFormProblems({ ...form, fxRate: null })).toEqual({ rate: "exchangeRateInvalid" });
    expect(marketFormProblems({ ...form, fxLockMinutes: 2 })).toEqual({ lock: "rateLockInvalid" });
    // Back to the shop currency: no currency of its own and no rate.
    expect(marketUpdateBody({ ...form, currencyCode: "BDT" }, 1)).toMatchObject({ currencyCode: null, fxRate: null });
  });

  it("lets an exchange rate app set the rate: its id is sent, a typed rate is not, and no typed rate is needed", () => {
    const own = { ...marketForm(india), currencyCode: "GBP", fxRate: "0.0068", priceMode: "fx" as const };
    // Manual (the default) keeps sending the typed rate, with the source it came from.
    expect(marketForm(india).fxRateSource).toBe("manual");
    expect(marketUpdateBody(own, 1)).toMatchObject({ currencyCode: "GBP", fxRate: "0.0068", fxRateSource: "manual" });
    const app = { ...own, fxRateSource: "acme.rates:daily", fxRate: null };
    expect(marketFormProblems(app)).toEqual({});
    const body = marketUpdateBody(app, 1);
    expect(body).toMatchObject({ currencyCode: "GBP", fxRateSource: "acme.rates:daily", priceMode: "fx" });
    expect(body).not.toHaveProperty("fxRate");
    // A market in the shop currency has no source to send; the API returns it to manual.
    expect(marketUpdateBody({ ...app, currencyCode: "BDT" }, 1)).not.toHaveProperty("fxRateSource");
    expect(marketForm({ ...india, fxRateSource: "acme.rates:daily" })).toMatchObject({
      fxRateSource: "acme.rates:daily", savedFxRateSource: "acme.rates:daily",
    });
  });

  it("names what blocks a save", () => {
    const form = marketForm(india);
    expect(marketFormProblems(form)).toEqual({});
    expect(marketFormProblems({ ...form, name: " ", handle: "In dia", countries: [], subfolder: true, suffix: "i" })).toEqual({
      name: "nameRequired", handle: "handleInvalid", countries: "countriesRequired", suffix: "suffixInvalid",
    });
    // The backup market may sell to no country of its own: it catches every buyer.
    expect(marketFormProblems({ ...marketForm(backup), countries: [] })).toEqual({});
  });

  it("knows which countries other markets hold", () => {
    expect([...countriesTakenByOthers([backup, india], "mkt_in")]).toEqual([["BD", "Bangladesh"]]);
    expect([...countriesTakenByOthers([backup, india], null)].map(([code]) => code)).toEqual(["BD", "IN", "NP"]);
  });
});

describe("markets settings", () => {
  let root: Root;
  let container: HTMLDivElement;
  let scope: SaveScopeState | null;

  beforeEach(() => {
    vi.clearAllMocks();
    scope = null;
    notifyManager.setNotifyFunction((callback) => { act(callback); });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    // A one-currency store: only cash on delivery, which charges no other currency.
    sdk.getApiV1AdminSettingsMarketsCurrencies.mockImplementation(() => envelope({ shopCurrencyCode: "BDT", chargeable: ["BDT"], marketCurrencies: [] }));
    sdk.getApiV1AdminSettingsLanguages.mockImplementation(() => envelope({ items: [
      { locale: "bn", published: true, isDefault: true, presences: [""], translatedResources: 0 },
      { locale: "en", published: true, isDefault: false, presences: [], translatedResources: 4 },
    ] }));
    sdk.getApiV1AdminSettingsProviders.mockImplementation(() => envelope({ providers: [] }));
    sdk.getApiV1AdminSettingsMarkets.mockImplementation(() => envelope({ items: [backup, { ...india, presence: { value: "en-in", locale: "en" } }] }));
    sdk.getApiV1AdminSettingsMarketsById.mockImplementation(({ path: { id } }: { path: { id: string } }) =>
      envelope({ market: id === "mkt_backup" ? backup : india }));
    sdk.patchApiV1AdminSettingsMarketsById.mockImplementation(({ path: { id }, body }: { path: { id: string }; body: Record<string, unknown> }) => {
      const current = id === "mkt_backup" ? backup : india;
      // The API answers the market's currency, never null (null in a body is the shop currency).
      const { expectedRevision: _revision, currencyCode, ...changes } = body;
      return envelope({ market: { ...current, ...changes, currencyCode: currencyCode ?? current.shopCurrencyCode, revision: current.revision + 1 } });
    });
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
            <SaveScope render={(next) => { scope = next; return null; }}>{children}</SaveScope>
          </PermissionProvider>
        </QueryClientProvider>,
      );
    });
    return queryClient;
  }

  const switchNamed = (text: string) =>
    [...container.querySelectorAll("label")].find((label) => label.textContent?.includes(text))!.querySelector<HTMLButtonElement>("button[role=switch]")!;

  it("lists each market with its status, countries and currency, the primary one labelled", async () => {
    await render(<MarketsList />);
    await vi.waitFor(() => expect(container.querySelectorAll("tbody tr")).toHaveLength(2));
    const [first, second] = [...container.querySelectorAll("tbody tr")].map((row) => row.textContent);
    expect(first).toContain("Bangladesh");
    expect(first).toContain("Primary");
    expect(first).toContain("Active");
    expect(first).toContain("BDT");
    expect(second).toContain("India, Nepal");
    expect(second).toContain("Draft");
    // The web address column shows because India has one.
    expect(second).toContain("/en-in");
    expect(container.textContent).toContain("Add market");
    expect(container.textContent).not.toContain("Backup");
  });

  it("shows a store with one market a sentence and one way to sell elsewhere, not a table", async () => {
    sdk.getApiV1AdminSettingsMarkets.mockImplementation(() => envelope({ items: [backup] }));
    await render(<MarketsList />);
    await vi.waitFor(() => expect(container.textContent).toContain("Your store sells in Bangladesh, in BDT, in Bangla."));
    expect(container.querySelector("table")).toBeNull();
    expect(container.textContent).toContain("Primary");
    expect([...container.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["Sell in another country"]);
    expect(container.textContent).not.toContain("Web address");
    // The whole row opens the market: one link around the name and the sentence, not only the name.
    // Named by its own text (WCAG 2.5.3): no aria-label that hides the sentence.
    const rows = [...container.querySelectorAll<HTMLAnchorElement>("a[href='/admin/settings/markets/$marketId']")];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain("Your store sells in Bangladesh");
  });

  it("opens a market from anywhere on its row in the table", async () => {
    await render(<MarketsList />);
    await vi.waitFor(() => expect(container.querySelectorAll("tbody tr")).toHaveLength(2));
    const link = container.querySelector("tbody tr a")!;
    // The name's link covers the row (a stretched link), and the row ends in a chevron.
    expect(link.className).toContain("after:inset-0");
    expect(container.querySelector("tbody tr")!.className).toContain("relative");
    expect(container.querySelector("tbody tr svg")).not.toBeNull();
  });

  it("puts the error colour on the country list, not on the search field above it", async () => {
    await render(<MarketsList />);
    await vi.waitFor(() => expect(container.querySelectorAll("tbody tr")).toHaveLength(2));
    await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent === "Add market")!.click());
    // The name's help is a sentence on its own.
    expect(document.body.textContent).toContain("Only you and your staff see this name. For example, Europe.");
    await act(async () => {
      document.querySelector<HTMLButtonElement>("button[form=market-create-form]")!.click();
    });
    await vi.waitFor(() => expect(document.body.textContent).toContain("Add at least one country."));
    expect(document.querySelector("#market-create-countries")!.getAttribute("aria-invalid")).toBeNull();
    expect(document.querySelector("[data-slot=country-list]")!.getAttribute("aria-invalid")).toBe("true");
  });

  it("saves the backup market's price increment under the revision it loaded", async () => {
    await render(<MarketEditor marketId="mkt_backup" />);
    await vi.waitFor(() => expect(container.textContent).toContain("Prices in whole amounts"));
    expect(container.textContent).toContain("Your primary market is always active");
    // The handle and web address are behind one quiet row, closed.
    expect(container.querySelector("#market-handle")).toBeNull();
    // Another market's countries can't be added here.
    await vi.waitFor(() => expect(container.textContent).toContain("In India"));
    expect([...container.querySelectorAll("label")].find((label) => label.textContent?.startsWith("India"))!
      .querySelector<HTMLInputElement>("input[type=checkbox]")!.disabled).toBe(true);
    // A market with orders is never deleted, and the backup market has no delete action at all.
    expect(container.textContent).not.toContain("Delete market");

    act(() => switchNamed("Prices in whole amounts").click());
    expect(container.textContent).toContain("Cash on delivery still collects whole taka");
    let saved = false;
    await act(async () => { saved = await scope!.saveAll(); });
    expect(saved).toBe(true);
    expect(sdk.patchApiV1AdminSettingsMarketsById).toHaveBeenCalledWith({
      path: { id: "mkt_backup" },
      body: { expectedRevision: 3, name: "Bangladesh", handle: "bangladesh", countries: ["BD"], presence: { value: "", locale: "bn" }, priceIncrementMinor: 1, pricesIncludeTax: true },
    });
  });

  it("saves whether a market's prices include tax (MARKETS-DESIGN D8)", async () => {
    await render(<MarketEditor marketId="mkt_in" />);
    await vi.waitFor(() => expect(container.textContent).toContain("Prices include tax"));
    expect(switchNamed("Prices include tax").getAttribute("aria-checked")).toBe("true");
    act(() => switchNamed("Prices include tax").click());
    let saved = false;
    await act(async () => { saved = await scope!.saveAll(); });
    expect(saved).toBe(true);
    expect(sdk.patchApiV1AdminSettingsMarketsById.mock.calls[0]![0].body).toMatchObject({ pricesIncludeTax: false });
  });

  it("offers the currencies a payment method charges, and asks for a rate only for another one", async () => {
    sdk.getApiV1AdminSettingsMarketsCurrencies.mockImplementation(() => envelope({ shopCurrencyCode: "BDT", chargeable: "any", marketCurrencies: [] }));
    await render(<MarketEditor marketId="mkt_in" />);
    await vi.waitFor(() => expect(container.querySelector("#market-currency")).not.toBeNull());
    expect(container.textContent).toContain("Most stores keep BDT.");
    expect(container.textContent).not.toContain("Exchange rate");
  });

  it("gives another market a web address, behind Advanced, in one of the store's languages", async () => {
    await render(<MarketEditor marketId="mkt_in" />);
    await vi.waitFor(() => expect(container.textContent).toContain("Web address and handle"));
    expect(container.textContent).not.toContain("Give this market its own web address");
    act(() => [...container.querySelectorAll("button")].find((button) => button.textContent === "Web address and handle")!.click());
    await vi.waitFor(() => expect(container.textContent).toContain("Give this market its own web address"));
    expect(container.querySelector("#market-handle")).not.toBeNull();
    // A store that can charge only its own currency sees no currency choice, just how to get one.
    await vi.waitFor(() => expect(container.textContent).toContain("This market sells in BDT, like the rest of your store."));
    expect(container.querySelector("#market-currency")).toBeNull();
    expect(container.textContent).not.toContain("Exchange rate");
    expect(container.textContent).toContain("Delete market");

    // Off, the switch says what it gives; it makes no claim about orders.
    expect(container.textContent).toContain("Without an address of its own");
    expect(container.textContent).not.toContain("count for this market");

    act(() => switchNamed("Give this market its own web address").click());
    await vi.waitFor(() => expect(container.querySelector("code")?.textContent).toBe("/en-in"));
    // Language stacks above its select like every other field: its box is a block, not inline beside the label.
    const languageBox = container.querySelector<HTMLElement>('[data-slot="searchable-select"]')!;
    expect(languageBox.classList.contains("block")).toBe(true);
    expect(languageBox.classList.contains("inline-block")).toBe(false);
    let saved = false;
    await act(async () => { saved = await scope!.saveAll(); });
    expect(saved).toBe(true);
    const body = sdk.patchApiV1AdminSettingsMarketsById.mock.calls[0]![0].body;
    expect(body).toMatchObject({ expectedRevision: 1, status: "draft", presence: { value: "en-in", locale: "en" } });
    expect(body).not.toHaveProperty("priceIncrementMinor");
  });
  it("gives another market adjusted prices with a live preview (MARKETS-DESIGN D5)", async () => {
    await render(<MarketEditor marketId="mkt_in" />);
    await vi.waitFor(() => expect(container.textContent).toContain("Adjusted product prices"));
    const adjusted = [...container.querySelectorAll("label")].find((label) => label.textContent?.startsWith("Adjusted product prices"))!;
    act(() => adjusted.querySelector<HTMLButtonElement>("button[role=radio]")!.click());
    await vi.waitFor(() => expect(container.textContent).toContain("Price adjustment"));
    const input = container.querySelector<HTMLInputElement>("#market-adjustment")!;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      set.call(input, "10");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // ৳1,299 × 1.10, at the whole-taka increment.
    await vi.waitFor(() => expect(container.textContent).toContain("1,299.00 becomes ৳1,429.00"));
    let saved = false;
    await act(async () => { saved = await scope!.saveAll(); });
    expect(saved).toBe(true);
    expect(sdk.patchApiV1AdminSettingsMarketsById.mock.calls[0]![0].body).toMatchObject({
      priceMode: "fx", priceAdjustmentPercent: 10, priceRounding: null, priceEnding: null,
    });
  });

  describe("exchange rate source", () => {
    const ownGbp = {
      ...india, id: "mkt_gb", handle: "uk", name: "United Kingdom", countries: ["GB"],
      currencyCode: "GBP", priceMode: "fx" as const, fxRate: "0.0068", fxRateAsOf: "2026-10-01T09:00:00.000Z", fxRateSource: "manual",
    };

    async function openEditor(market: typeof ownGbp, providers: unknown[]) {
      sdk.getApiV1AdminSettingsMarketsById.mockImplementation(() => envelope({ market }));
      sdk.getApiV1AdminSettingsProviders.mockImplementation(() => envelope({ providers }));
      await render(<MarketEditor marketId={market.id} />);
      await vi.waitFor(() => expect(container.querySelector("#market-currency")).not.toBeNull());
    }

    it("offers no source to choose from while no exchange rate app is installed", async () => {
      await openEditor(ownGbp, []);
      await vi.waitFor(() => expect(container.querySelector("#market-rate")).not.toBeNull());
      expect(container.querySelector("#market-rate-source")).toBeNull();
    });

    it("lets an app take over: the typed rate goes, and the save sends the app, not a rate", async () => {
      await openEditor(ownGbp, [dailyRates]);
      await vi.waitFor(() => expect(container.querySelector("#market-rate-source")).not.toBeNull());
      expect(container.querySelector("#market-rate")).not.toBeNull();
      await act(async () => container.querySelector<HTMLButtonElement>("#market-rate-source")!.click());
      await vi.waitFor(() => expect(document.querySelectorAll('[role="option"]')).toHaveLength(2));
      const options = [...document.querySelectorAll<HTMLElement>('[role="option"]')];
      expect(options.map((option) => option.textContent)).toEqual([
        expect.stringContaining("Manual"),
        expect.stringContaining("Daily rates"),
      ]);
      expect(options[1]!.textContent).toContain("by Acme rates");
      await act(async () => options[1]!.click());
      await vi.waitFor(() => expect(container.querySelector("#market-rate")).toBeNull());
      expect(container.textContent).toContain("Daily rates sets the rate when you save.");

      let saved = false;
      await act(async () => { saved = await scope!.saveAll(); });
      expect(saved).toBe(true);
      const body = sdk.patchApiV1AdminSettingsMarketsById.mock.calls[0]![0].body;
      expect(body).toMatchObject({ expectedRevision: 1, currencyCode: "GBP", fxRateSource: "acme.rates:daily" });
      expect(body).not.toHaveProperty("fxRate");
    });

    it("shows an app's rate as one sentence with its age and the app, and no rate field", async () => {
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60_000).toISOString();
      await openEditor({ ...ownGbp, fxRate: "0.0084", fxRateAsOf: fiveMinutesAgo, fxRateSource: "acme.rates:daily" }, [dailyRates]);
      await vi.waitFor(() => expect(container.textContent).toContain("1 BDT = 0.0084 GBP · updated 5 min ago by Daily rates"));
      expect(container.querySelector("#market-rate")).toBeNull();
      expect(container.querySelector("#market-lock")).not.toBeNull();
    });

    it("hides the source for a market that sells in the shop currency", async () => {
      sdk.getApiV1AdminSettingsProviders.mockImplementation(() => envelope({ providers: [dailyRates] }));
      await render(<MarketEditor marketId="mkt_in" />);
      await vi.waitFor(() => expect(container.textContent).toContain("Prices include tax"));
      expect(container.querySelector("#market-rate-source")).toBeNull();
    });
  });
});

describe("market country picker", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function Picker({ initial = [] }: { initial?: string[] }) {
    const [selected, setSelected] = useState<string[]>(initial);
    return <MarketCountryPicker id="countries" selected={selected} taken={new Map([["BD", "Bangladesh"]])} onChange={setSelected} />;
  }

  const list = () => container.querySelector<HTMLElement>('[data-slot="country-list"]')!;
  const chips = () => container.querySelector<HTMLElement>('[data-slot="country-chips"]')!;
  const search = (value: string) => {
    const input = container.querySelector<HTMLInputElement>("input[type=search]")!;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      set.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const rows = () => list().querySelectorAll("label").length;

  it("keeps the list in a box of fixed height, so filtering changes rows and never the size", async () => {
    await act(async () => root.render(<Picker />));
    const box = list();
    const full = rows();
    expect(box.classList.contains("h-64")).toBe(true);
    expect(box.classList.contains("max-h-64")).toBe(false);
    search("india");
    expect(rows()).toBeLessThan(full);
    expect(rows()).toBeGreaterThan(0);
    // The same box, with the same fixed height class and no inline size.
    expect(list()).toBe(box);
    expect(box.classList.contains("h-64")).toBe(true);
    expect(box.getAttribute("style")).toBeNull();
    // Nothing found: the message sits in the same box.
    search("zzzz");
    expect(rows()).toBe(0);
    expect(list()).toBe(box);
    expect(box.textContent).toContain("No country found.");
    expect(box.classList.contains("h-64")).toBe(true);
  });

  it("puts the search field first and the chips below the list, in a row that keeps one row's height", async () => {
    await act(async () => root.render(<Picker />));
    const input = container.querySelector("input[type=search]")!;
    expect(input.compareDocumentPosition(list()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(list().compareDocumentPosition(chips()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Empty: a hint holds the row's height, so the first pick pushes nothing.
    expect(chips().textContent).toBe("No countries added yet.");
    const emptyClass = chips().className;
    expect(emptyClass).toContain("min-h-9");
    expect(emptyClass).toContain("sm:min-h-7");

    search("india");
    act(() => list().querySelector<HTMLInputElement>("input[type=checkbox]")!.click());
    expect(chips().textContent).toContain("India");
    expect(chips().querySelectorAll("button")).toHaveLength(1);
    // The search text, the list's box and the row's size classes are untouched by the pick.
    expect(container.querySelector<HTMLInputElement>("input[type=search]")!.value).toBe("india");
    expect(chips().className).toBe(emptyClass);
    expect(list().classList.contains("h-64")).toBe(true);
  });
});
