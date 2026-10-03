// @vitest-environment happy-dom
/**
 * Settings › Markets (docs/MARKETS-DESIGN.md D4): the list, and one market's
 * page saving under its revision. The backup market keeps the root URL and
 * owns the price increment; another market sells at a subfolder and uses
 * the backup market's increment; each country belongs to one market.
 */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  getApiV1AdminSettingsMarkets: vi.fn(),
  getApiV1AdminSettingsMarketsById: vi.fn(),
  patchApiV1AdminSettingsMarketsById: vi.fn(),
  postApiV1AdminSettingsMarkets: vi.fn(),
  deleteApiV1AdminSettingsMarketsById: vi.fn(),
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
import { MarketEditor } from "./MarketEditor";
import { MarketsList } from "./MarketsList";
import {
  countriesTakenByOthers,
  marketForm,
  marketFormProblems,
  marketUpdateBody,
  presencePath,
  withSubfolder,
} from "./market-form";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const envelope = <T,>(data: T) => Promise.resolve({ data: { success: true, data } });
const backup = {
  id: "mkt_backup", handle: "bangladesh", name: "Bangladesh", status: "active" as const, isBackup: true, revision: 3,
  countries: ["BD"], presence: { value: "", locale: "bn" }, currencyCode: "BDT", priceIncrementMinor: 100,
  priceIncrementInherited: false, hasOrders: true, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
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
      presence: { value: "", locale: "en" }, priceIncrementMinor: 1,
    });
  });

  it("saves another market's subfolder as language and country code, without an increment", () => {
    const form = withSubfolder(marketForm(india), true);
    expect(form).toMatchObject({ subfolder: true, suffix: "in", locale: "en" });
    expect(presencePath(form)).toBe("/en-in");
    expect(marketUpdateBody({ ...form, status: "active" }, 1)).toEqual({
      expectedRevision: 1, name: "India", handle: "india", status: "active", countries: ["IN", "NP"],
      presence: { value: "en-in", locale: "en" },
    });
    expect(marketUpdateBody(withSubfolder(form, false), 1).presence).toBeNull();
    expect(marketForm({ ...india, presence: { value: "bn-in", locale: "bn" } })).toMatchObject({ subfolder: true, suffix: "in", locale: "bn" });
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
    sdk.getApiV1AdminSettingsMarkets.mockImplementation(() => envelope({ items: [backup, { ...india, presence: { value: "en-in", locale: "en" } }] }));
    sdk.getApiV1AdminSettingsMarketsById.mockImplementation(({ path: { id } }: { path: { id: string } }) =>
      envelope({ market: id === "mkt_backup" ? backup : india }));
    sdk.patchApiV1AdminSettingsMarketsById.mockImplementation(({ path: { id }, body }: { path: { id: string }; body: Record<string, unknown> }) => {
      const current = id === "mkt_backup" ? backup : india;
      const { expectedRevision: _revision, ...changes } = body;
      return envelope({ market: { ...current, ...changes, revision: current.revision + 1 } });
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

  it("lists each market with its status, countries, currency and web presence, the backup labelled", async () => {
    await render(<MarketsList />);
    await vi.waitFor(() => expect(container.querySelectorAll("tbody tr")).toHaveLength(2));
    const [first, second] = [...container.querySelectorAll("tbody tr")].map((row) => row.textContent);
    expect(first).toContain("Bangladesh");
    expect(first).toContain("Backup");
    expect(first).toContain("Active");
    expect(first).toContain("BDT");
    expect(first).toContain("/");
    expect(second).toContain("India, Nepal");
    expect(second).toContain("Draft");
    expect(second).toContain("/en-in");
  });

  it("saves the backup market's price increment under the revision it loaded", async () => {
    await render(<MarketEditor marketId="mkt_backup" />);
    await vi.waitFor(() => expect(container.textContent).toContain("Prices in whole amounts"));
    expect(container.textContent).toContain("The backup market is always active");
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
      body: { expectedRevision: 3, name: "Bangladesh", handle: "bangladesh", countries: ["BD"], presence: { value: "", locale: "bn" }, priceIncrementMinor: 1 },
    });
  });

  it("gives another market a subfolder and says it uses the backup market's increment", async () => {
    await render(<MarketEditor marketId="mkt_in" />);
    await vi.waitFor(() => expect(container.textContent).toContain("Sell at a subfolder"));
    expect(container.textContent).toContain("This market uses the backup market's price increment: whole amounts.");
    expect(container.textContent).toContain("Every market sells in the shop currency for now.");
    expect(container.textContent).toContain("Delete market");

    act(() => switchNamed("Sell at a subfolder").click());
    await vi.waitFor(() => expect(container.querySelector("code")?.textContent).toBe("/en-in"));
    let saved = false;
    await act(async () => { saved = await scope!.saveAll(); });
    expect(saved).toBe(true);
    const body = sdk.patchApiV1AdminSettingsMarketsById.mock.calls[0]![0].body;
    expect(body).toMatchObject({ expectedRevision: 1, status: "draft", presence: { value: "en-in", locale: "en" } });
    expect(body).not.toHaveProperty("priceIncrementMinor");
  });
});
