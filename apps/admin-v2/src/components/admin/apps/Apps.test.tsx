// @vitest-environment happy-dom

import { act, type AnchorHTMLAttributes, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  getApiV1AdminApps: vi.fn(),
  getApiV1AdminAppsById: vi.fn(),
  postApiV1AdminAppsByIdActivate: vi.fn(),
  postApiV1AdminAppsByIdDeactivate: vi.fn(),
  putApiV1AdminAppsByIdSettings: vi.fn(),
  postApiV1AdminAppsByIdUninstall: vi.fn(),
  getApiV1AdminAppsByIdLogs: vi.fn(),
  getApiV1AdminAppsByIdDeliveries: vi.fn(),
  postApiV1AdminAppsByIdDeliveriesByDeliveryIdRetry: vi.fn(),
  getApiV1AdminAppsRegistry: vi.fn(),
  getApiV1AdminAppsRegistrySettings: vi.fn(),
  putApiV1AdminAppsRegistrySettings: vi.fn(),
  postApiV1AdminAppsRegistryInstall: vi.fn(),
  postApiV1AdminAppsByIdUpdate: vi.fn(),
  postApiV1AdminAppsUpload: vi.fn(),
  postApiV1AdminAppsStopThirdParty: vi.fn(),
  postApiV1AdminAppsByIdStop: vi.fn(),
  postApiV1AdminAppsByIdFeaturesByFeatureIdEnable: vi.fn(),
  postApiV1AdminAppsByIdFeaturesByFeatureIdDisable: vi.fn(),
  postApiV1AdminSettingsProvidersByIdTest: vi.fn(),
}));
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }));
const navigate = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("@scalius/api-client/sdk", () => sdk);
vi.mock("sonner", () => ({ toast: toasts }));
vi.mock("~/components/admin/shared/UnsavedChangesGuard", () => ({ UnsavedChangesGuard: () => null }));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
  useLocation: (options?: { select?: (location: { hash: string; pathname: string }) => unknown }) =>
    (options?.select ? options.select({ hash: "", pathname: "/admin/apps" }) : { hash: "", pathname: "/admin/apps" }),
  Link: ({ to, params, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string; params?: Record<string, string>; children: ReactNode }) => (
    <a href={params ? to.replace("$pluginId", params.pluginId ?? "") : to} {...props}>{children}</a>
  ),
}));

import { PermissionProvider } from "~/contexts/PermissionContext";
import { setLocale } from "~/i18n";
import { appQueryOptions } from "~/lib/api-query-options/apps";
import { AppDetailPage } from "./AppDetailPage";
import { AppsList } from "./AppsList";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const VIEWER = ["apps.view"];
const MANAGER = ["apps.view", "apps.manage"];
const ok = <T,>(data: T) => Promise.resolve({ data: { success: true, data }, response: { status: 200 } });
const refused = (status: number, details: Record<string, unknown>) =>
  Promise.resolve({ error: { success: false, error: { code: "plugin_error", message: "Refused.", details } }, response: { status } });

const grant = (overrides: Record<string, unknown> = {}) => ({
  scopes: ["read_customers", "read_orders"],
  allowedHosts: ["api.acme.example"],
  events: ["order.created"],
  functions: ["checkout.discounts"],
  extensions: [],
  blockingFunctions: [],
  providers: [],
  publicRoutes: true,
  storefrontScripts: [],
  storefrontSurfaces: false,
  customFieldOwners: ["customer"],
  ...overrides,
});

function summary(overrides: Record<string, unknown> = {}) {
  return {
    id: "acme.loyalty",
    name: "Loyalty points",
    version: "1.2.0",
    description: "Points for every order.",
    author: { name: "Acme", url: "https://acme.example" },
    homepage: null,
    tagline: null,
    icon: null,
    categories: [],
    countries: null,
    source: "bundled",
    status: "installed",
    needsApproval: false,
    thirdParty: false,
    signed: false,
    failureReason: null,
    revision: 3,
    installedAt: "2026-10-01T08:00:00.000Z",
    activatedAt: null,
    updatedAt: "2026-10-01T08:00:00.000Z",
    featureCount: { on: 0, total: 0 },
    functions: [],
    extensions: [],
    ...overrides,
  };
}

const field = (overrides: Record<string, unknown>) => ({
  help: null,
  required: false,
  options: null,
  default: null,
  min: null,
  max: null,
  integer: false,
  maxLength: null,
  ...overrides,
});

function detail(overrides: Record<string, unknown> = {}) {
  return {
    ...summary(),
    screenshots: [],
    support: null,
    privacyPolicyUrl: null,
    documentationUrl: null,
    changelogUrl: null,
    minPlatformVersion: null,
    grantKey: "grant-key-v3",
    request: grant(),
    granted: null,
    added: grant(),
    scopes: [
      { name: "read_customers", risk: "read", sensitive: true },
      { name: "read_orders", risk: "read", sensitive: false },
    ],
    activatedBy: null,
    runtime: "bundled",
    runtimeAvailable: true,
    settings: {
      fields: [
        field({ key: "points_per_taka", label: "Points per taka", type: "number", required: true, min: 0, max: 100, integer: true }),
        field({ key: "program_name", label: "Program name", type: "text", maxLength: 40 }),
        field({ key: "tiers", label: "Tiers", type: "multiselect", options: [{ value: "silver", label: "Silver" }, { value: "gold", label: "Gold" }] }),
        field({ key: "api_key", label: "API key", type: "secret" }),
      ],
      values: { points_per_taka: 2, program_name: "Acme rewards", tiers: ["gold"] },
      secrets: { api_key: true },
      missing: [],
      sections: [{ group: null, keys: ["points_per_taka", "program_name", "tiers", "api_key"] }],
    },
    providers: [],
    routes: { admin: [], public: [], webhooks: [] },
    cron: [],
    storage: [],
    customFields: [],
    storefront: { proxy: false, head: false, sections: [], components: [], scripts: [], themeProblems: [] },
    admin: { pages: [], cards: [], actions: [], widgets: [] },
    limits: { cpuMs: 50, wallMs: 1000, subrequests: 20, invocationsPerMinute: 60, storageBytes: 10 * 1024 * 1024 },
    storageUsage: { bytes: 0, measuredAt: null },
    signer: null,
    migrations: { declared: [], applied: 0 },
    features: [],
    ...overrides,
  };
}

/** One feature of an app, off unless `enabled`. */
function feature(overrides: Record<string, unknown> = {}) {
  return {
    id: "bkash",
    name: "bKash",
    description: "Take bKash payments at checkout.",
    enabled: false,
    recommended: false,
    request: {
      scopes: [],
      allowedHosts: ["tokenized.pay.bka.sh", "tokenized.sandbox.bka.sh"],
      providers: [{ id: "acme.loyalty:bkash", kind: "payment", name: "bKash", icon: null }],
      events: [],
      functions: [],
      publicRoutes: false,
      storefront: false,
      admin: false,
      cron: [],
    },
    grantKey: "feature-key-bkash",
    settings: [],
    pages: [],
    ...overrides,
  };
}

const placesFeature = () => feature({
  id: "places",
  name: "Bangladesh places",
  description: "The City, Thana and Area list.",
  recommended: true,
  request: {
    scopes: [{ name: "write_places", risk: "write", sensitive: false }],
    allowedHosts: [], providers: [], events: [], functions: [], publicRoutes: false, storefront: false, admin: true, cron: ["places_sync"],
  },
  grantKey: "feature-key-places",
  pages: ["places"],
});

function delivery(overrides: Record<string, unknown> = {}) {
  return {
    id: "pdl_1",
    eventId: "evt_1",
    topic: "order.created",
    resourceType: "order",
    resourceId: "ord_1",
    status: "failed",
    attempts: 2,
    maxAttempts: 8,
    durationMs: 120,
    error: "Points service answered 500",
    nextAttemptAt: null,
    lastAttemptAt: "2026-10-01T08:00:00.000Z",
    deliveredAt: null,
    createdAt: "2026-10-01T08:00:00.000Z",
    ...overrides,
  };
}

let host: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;

async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

/** The app page as its route shows it: from the detail query, so invalidation refetches. */
function AppRoute({ id, section }: { id: string; section?: string }) {
  const { data } = useQuery(appQueryOptions(id));
  return data ? <AppDetailPage app={data} sectionKey={section} /> : null;
}

async function render(node: ReactNode, permissions: string[], isSuperAdmin = false) {
  await act(async () =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <PermissionProvider permissions={permissions} isSuperAdmin={isSuperAdmin}>{node}</PermissionProvider>
      </QueryClientProvider>,
    ),
  );
  await flush();
}

async function renderApp(app: object, permissions: string[], isSuperAdmin = false, section?: string) {
  sdk.getApiV1AdminAppsById.mockImplementation(() => ok({ app }));
  await render(<AppRoute id="acme.loyalty" section={section} />, permissions, isSuperAdmin);
  await vi.waitFor(() => expect(text()).toContain("Loyalty points"));
}

const text = () => document.body.textContent ?? "";
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"], [role="alertdialog"]')!;

function button(label: string, within: ParentNode = document): HTMLButtonElement {
  const match = [...within.querySelectorAll("button")].find((element) => element.textContent?.trim() === label);
  if (!match) throw new Error(`No button "${label}"`);
  return match;
}

const hasButton = (label: string) => [...document.querySelectorAll("button")].some((element) => element.textContent?.trim() === label);

async function click(element: HTMLElement) {
  await act(async () => element.click());
  await flush();
}

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function chooseMenuItem(label: string) {
  const trigger = button("More actions");
  await act(async () => {
    trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
  });
  await flush();
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((element) => element.textContent?.trim() === label);
  if (!item) throw new Error(`No menu item "${label}"`);
  await click(item);
}

/** Presses the page save bar's Save and returns the settings body sent. */
async function saveSettings() {
  const before = sdk.putApiV1AdminAppsByIdSettings.mock.calls.length;
  await click(button("Save", document.querySelector<HTMLElement>("[data-save-bar]")!));
  await vi.waitFor(() => expect(sdk.putApiV1AdminAppsByIdSettings).toHaveBeenCalledTimes(before + 1));
  await vi.waitFor(() => expect(document.querySelector("[data-save-bar]")).toBeNull());
  return sdk.putApiV1AdminAppsByIdSettings.mock.calls.at(-1)![0] as { path: { id: string }; body: { expectedRevision: number; values: Record<string, unknown> } };
}

const input = (key: string) => document.getElementById(`app-setting-${key}`) as HTMLInputElement;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  sdk.getApiV1AdminAppsByIdDeliveries.mockImplementation(() => ok({ deliveries: [], nextCursor: null }));
  sdk.getApiV1AdminAppsByIdLogs.mockImplementation(() => ok({ lines: [], nextCursor: null }));
  sdk.putApiV1AdminAppsByIdSettings.mockImplementation(() => ok({ app: detail({ revision: 4 }) }));
});

afterEach(() => {
  setLocale("en");
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

function listing(overrides: Record<string, unknown> = {}) {
  return {
    id: "scalius.gift-wrap",
    name: "Gift wrap",
    version: "1.0.0",
    description: "Buyers ask for gift wrap at checkout.",
    author: { name: "Scalius", url: null },
    homepage: null,
    tagline: "Wrap orders as gifts",
    icon: "/api/v1/admin/apps/scalius.gift-wrap/assets/icon?v=cccccccccccccccc",
    categories: ["orders"],
    countries: null,
    screenshots: ["/api/v1/admin/apps/scalius.gift-wrap/assets/screenshot-1?v=cccccccccccccccc"],
    support: { url: "https://help.example/gift", email: null },
    privacyPolicyUrl: null,
    documentationUrl: null,
    changelogUrl: "https://help.example/gift/changes",
    minPlatformVersion: "1.0.0",
    installCommand: "pnpm plugin add plugins/gift-wrap",
    ...overrides,
  };
}

const STORE = {
  apps: [
    summary({ id: "acme.loyalty", status: "active", tagline: "Points that bring buyers back", categories: ["loyalty", "marketing"] }),
    summary({ id: "scalius.bkash", name: "bKash", status: "active", tagline: "Take bKash payments at checkout", categories: ["payments"], countries: ["BD"], icon: "/api/v1/admin/apps/scalius.bkash/assets/icon?v=63a5ccd16b4c0000" }),
    summary({ id: "acme.sms", name: "SMS alerts", tagline: null, description: "Texts buyers when orders ship.", categories: ["notifications"] }),
    summary({ id: "acme.reviews", name: "Photo reviews", needsApproval: true, categories: ["marketing"] }),
    summary({ id: "acme.feed", name: "Product feed", status: "disabled" }),
    summary({ id: "acme.erp", name: "ERP sync", status: "failed", categories: ["operations"] }),
  ],
  available: [listing()],
  sandboxAvailable: false,
};

const rows = () => [...document.querySelectorAll("li")].map((row) => row.textContent ?? "");
const tab = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((element) => element.textContent?.startsWith(label))!;

describe("Apps list", () => {
  it("shows every installed app with its icon, status, purpose and features on, and links to its page", async () => {
    sdk.getApiV1AdminApps.mockImplementation(() => ok({
      ...STORE,
      apps: [...STORE.apps.slice(0, 1), summary({ id: "scalius.bangladesh", name: "Bangladesh pack", status: "active", tagline: "Payments, couriers and SMS", featureCount: { on: 3, total: 14 } }), ...STORE.apps.slice(1)],
    }));
    await render(<AppsList />, VIEWER);
    await vi.waitFor(() => expect(text()).toContain("ERP sync"));

    const list = rows();
    expect(list).toHaveLength(7);
    expect(list[0]).toContain("Loyalty points");
    expect(list[0]).toContain("Active");
    expect(list[0]).toContain("Points that bring buyers back");
    expect(list[1]).toContain("3 of 14 features on");
    // No tagline: the description stands in.
    expect(list[3]).toContain("Not active");
    expect(list[3]).toContain("Texts buyers when orders ship.");
    expect(list[4]).toContain("Update available");
    expect(list[5]).toContain("Off");
    expect(list[6]).toContain("Failed");
    // An app without features says nothing about them; an available app waits in Add apps.
    expect(list.filter((row) => row.includes("features on"))).toHaveLength(1);
    expect(text()).not.toContain("Gift wrap");
    expect(document.querySelector('a[href="/admin/apps/acme.erp"]')?.textContent).toContain("ERP sync");
    const bkashIcon = document.querySelector('a[href="/admin/apps/scalius.bkash"] img');
    expect(bkashIcon?.getAttribute("src")).toBe("/api/v1/admin/apps/scalius.bkash/assets/icon?v=63a5ccd16b4c0000");
    expect(bkashIcon?.getAttribute("alt")).toBe("");
  });

  it("has two views, Installed with its count and Add apps", async () => {
    sdk.getApiV1AdminApps.mockImplementation(() => ok(STORE));
    sdk.getApiV1AdminAppsRegistry.mockImplementation(() => ok({ installMode: "dashboard", officialConfigured: true, registries: [], apps: [] }));
    await render(<AppsList />, VIEWER);
    await vi.waitFor(() => expect(text()).toContain("ERP sync"));

    expect([...document.querySelectorAll('[role="tab"]')].map((element) => element.textContent)).toEqual(["Installed6", "Add apps"]);
    await click(tab("Add apps"));
    expect(tab("Add apps").getAttribute("aria-selected")).toBe("true");
    expect(rows()).toHaveLength(1);
    expect(text()).toContain("Gift wrap");
    expect(text()).not.toContain("ERP sync");
  });

  it("says why a stopped app is off on its row", async () => {
    sdk.getApiV1AdminApps.mockImplementation(() => ok({ ...STORE, apps: [summary({ id: "acme.feed", name: "Product feed", status: "disabled", failureReason: "Stopped with the emergency switch." })] }));
    await render(<AppsList />, VIEWER);
    await vi.waitFor(() => expect(text()).toContain("Product feed"));
    expect(rows()[0]).toContain("Stopped with the emergency switch.");
  });

  it("searches names, taglines and category names, and clears the search when nothing matches", async () => {
    sdk.getApiV1AdminApps.mockImplementation(() => ok(STORE));
    await render(<AppsList />, VIEWER);
    await vi.waitFor(() => expect(text()).toContain("ERP sync"));
    const search = document.querySelector<HTMLInputElement>('input[aria-label="Search apps"]')!;

    await type(search, "bkash");
    expect(rows()).toHaveLength(1);
    await type(search, "customer loyalty");
    expect(rows()).toHaveLength(1);
    expect(text()).toContain("Loyalty points");

    await type(search, "nothing like this");
    expect(text()).toContain("No apps match your search");
    await click(button("Clear filters"));
    expect(search.value).toBe("");
    expect(rows()).toHaveLength(6);
  });

  it("opens an available app's listing with the command that adds it", async () => {
    sdk.getApiV1AdminApps.mockImplementation(() => ok(STORE));
    sdk.getApiV1AdminAppsRegistry.mockImplementation(() => ok({ installMode: "dashboard", officialConfigured: true, registries: [], apps: [] }));
    await render(<AppsList />, VIEWER);
    await vi.waitFor(() => expect(text()).toContain("ERP sync"));
    await click(tab("Add apps"));

    await click([...document.querySelectorAll<HTMLButtonElement>("li button")].find((element) => element.textContent?.includes("Gift wrap"))!);
    await vi.waitFor(() => expect(dialog()?.textContent).toContain("Install Gift wrap"));
    const listingText = dialog().textContent ?? "";
    expect(listingText).toContain("by Scalius");
    expect(listingText).toContain("Wrap orders as gifts");
    expect(listingText).toContain("Every country");
    expect(listingText).toContain("Scalius 1.0.0 or later");
    expect(dialog().querySelector("code")?.textContent).toBe("pnpm plugin add plugins/gift-wrap");
    expect(dialog().querySelector('img[alt="Gift wrap screenshot 1"]')).not.toBeNull();
    expect(dialog().querySelector('a[href="https://help.example/gift/changes"]')).not.toBeNull();
  });

  it("opens on the apps a store can add when nothing is installed, and Installed asks for a first app", async () => {
    sdk.getApiV1AdminApps.mockImplementation(() => ok({ apps: [], available: [listing()], sandboxAvailable: false }));
    sdk.getApiV1AdminAppsRegistry.mockImplementation(() => ok({ installMode: "dashboard", officialConfigured: true, registries: [], apps: [] }));
    await render(<AppsList />, VIEWER);
    await vi.waitFor(() => expect(text()).toContain("Gift wrap"));
    expect(tab("Add apps").getAttribute("aria-selected")).toBe("true");
    await click(tab("Installed"));
    expect(text()).toContain("Add your first app");
    await click(button("Browse apps"));
    expect(text()).toContain("Gift wrap");
  });

  it("speaks Bangla, the app's own text included", async () => {
    setLocale("bn");
    sdk.getApiV1AdminApps.mockImplementation(() => ok({
      ...STORE,
      apps: [summary({ id: "scalius.bkash", name: "bKash", tagline: "Take bKash payments", categories: ["payments"], countries: ["BD"], featureCount: { on: 1, total: 3 }, translations: { bn: { name: "বিকাশ", tagline: "চেকআউটে বিকাশ পেমেন্ট নিন" } } })],
    }));
    await render(<AppsList />, VIEWER);
    await vi.waitFor(() => expect(text()).toContain("বিকাশ"));
    expect(text()).toContain("চেকআউটে বিকাশ পেমেন্ট নিন");
    expect(text()).toContain("অ্যাপ যোগ করুন");
    expect(text()).toContain("৩টি ফিচারের মধ্যে ১টি চালু");
  });
});

describe("App page", () => {
  it("shows the app's listing: icon, tagline, screenshots, categories, countries, links and changelog", async () => {
    await renderApp(detail({
      icon: "/api/v1/admin/apps/acme.loyalty/assets/icon?v=aaaaaaaaaaaaaaaa",
      tagline: "Points that bring buyers back",
      categories: ["loyalty", "marketing"],
      countries: ["BD", "IN"],
      screenshots: ["/api/v1/admin/apps/acme.loyalty/assets/screenshot-1?v=aaaaaaaaaaaaaaaa"],
      support: { url: null, email: "help@acme.example" },
      documentationUrl: "https://acme.example/docs",
      privacyPolicyUrl: "https://acme.example/privacy",
      changelogUrl: "https://acme.example/changes",
      minPlatformVersion: "1.0.0",
    }), VIEWER);

    expect(document.querySelector("h1 img")?.getAttribute("src")).toBe("/api/v1/admin/apps/acme.loyalty/assets/icon?v=aaaaaaaaaaaaaaaa");
    expect(text()).toContain("Points that bring buyers back");
    expect(text()).toContain("Customer loyalty, Marketing");
    expect(text()).toContain("Bangladesh, India");
    expect(text()).toContain("Scalius 1.0.0 or later");
    expect(document.querySelector('img[alt="Loyalty points screenshot 1"]')).not.toBeNull();
    for (const href of ["mailto:help@acme.example", "https://acme.example/docs", "https://acme.example/privacy", "https://acme.example/changes"]) {
      expect(document.querySelector(`a[href="${href}"]`), href).not.toBeNull();
    }
  });

  it("reports the templates and page presets the store's theme cannot use", async () => {
    await renderApp(detail({
      storefront: {
        proxy: false, head: false, sections: [], components: [], scripts: [],
        themeProblems: [{ kind: "page-preset", id: "launch", name: "Launch page", problem: "Version 9 is older than the oldest readable version (10)." }],
      },
    }), VIEWER);
    const alert = document.querySelector('[data-slot="theme-problems"]')!;
    expect(alert.textContent).toContain("Some of this app's designs don't fit your theme");
    expect(alert.textContent).toContain("Page preset Launch page");
    expect(alert.textContent).toContain("Version 9 is older");
  });

  it("says an app without a country list serves every country and shows no empty links", async () => {
    await renderApp(detail(), VIEWER);
    expect(text()).toContain("Every country");
    expect(text()).not.toContain("Changelog");
    expect(text()).not.toContain("Screenshots");
    expect(document.querySelector("h1 img")).toBeNull();
  });

  it("lists the access the app asks for in plain words", async () => {
    await renderApp(detail(), VIEWER);

    expect(text()).toContain("View customers");
    expect(text()).toContain("View orders");
    // Each scope says what it lets the app do.
    expect(text()).toContain("Buyers' contact details stay hidden unless the app may also see them.");
    expect(text()).toContain("Sensitive");
    expect(text()).toContain("Read");
    expect(text()).toContain("Order created");
    expect(text()).toContain("Offer discounts at checkout");
    expect(text()).toContain("Answers requests from the internet and your storefront");
    expect(text()).toContain("api.acme.example");
    expect(text()).toContain("Customers");
    // Nothing is marked new before the first approval.
    expect(text()).not.toContain("New");
  });

  it("says when an app redesigns the storefront and which hosts its storefront code connects to, marking what an update adds", async () => {
    await renderApp(
      detail({
        request: grant({ storefrontCode: true, storefrontConnect: ["cdn.acme.example", "reviews.acme.example"] }),
        granted: grant({ storefrontCode: true, storefrontConnect: ["cdn.acme.example"] }),
        added: grant({ scopes: [], allowedHosts: [], events: [], functions: [], publicRoutes: false, customFieldOwners: [], storefrontConnect: ["reviews.acme.example"] }),
      }),
      VIEWER,
    );

    expect(text()).toContain("Redesigns your storefront with its own code");
    expect(text()).toContain("Its storefront code connects to cdn.acme.example from your buyers' browsers");
    const newRows = [...document.querySelectorAll("li")].filter((row) => row.textContent?.includes("New"));
    expect(newRows.map((row) => row.textContent)).toEqual([expect.stringContaining("reviews.acme.example")]);
  });

  it("says when an app can pause checkout or updates a buyer's record with each order", async () => {
    await renderApp(
      detail({
        request: grant({ functions: ["cart.validate", "checkout.discounts"], blockingFunctions: ["cart.validate"] }),
        functions: [
          { point: "cart.validate", priority: 5, onError: "block", reads: [] },
          { point: "checkout.discounts", priority: 10, onError: "skip", reads: [{ as: "balance", object: "balances", customFields: [], key: "customer" }] },
        ],
      }),
      VIEWER,
    );
    expect(text()).toContain("Can pause checkout when it can't answer: Check carts");
    expect(text()).toContain("Reads its \"balances\" records at checkout and may update them with the order");
  });

  it("explains storefront extensions and their reads in the consent list, not among checkout functions", async () => {
    await renderApp(detail({
      request: grant({ extensions: ["checkout.actions.before", "account.overview"] }),
      extensions: [
        { target: "checkout.actions.before", reads: [{ as: "balance", object: "balances", customFields: [], key: "customer" }] },
        { target: "account.overview", reads: [{ as: "balance", object: "balances", customFields: [], key: "customer" }] },
      ],
    }), VIEWER);
    expect(text()).toContain("Shows content and asks buyers questions in the cart, checkout, order and account pages");
    expect(text().split("Reads its \"balances\" records to show buyers its content")).toHaveLength(2);
    expect(text()).not.toContain("Checkout functions");
  });

  it("lists its checkout functions in plain words with their priority, in checkout order", async () => {
    await renderApp(
      detail({
        functions: [
          { point: "cart.validate", priority: 5, reads: [] },
          { point: "checkout.discounts", priority: 10, reads: [] },
        ],
      }),
      VIEWER,
    );
    expect(text()).toContain("Checkout functions");
    expect(text()).toContain("the app with the lowest priority number runs first");
    const rows = [...document.querySelectorAll("li")]
      .map((row) => row.textContent ?? "")
      .filter((row) => row.includes("Priority"));
    expect(rows).toEqual([
      "Checks carts before checkoutPriority 5",
      "Adds discounts at checkoutPriority 10",
    ]);
  });

  it("shows readable declared schedules with honest cadence and collapsed exact cron details", async () => {
    const expressions = ["*/5 * * * *", " 0 9 1-31 * 1 "];
    await renderApp(detail({ cron: expressions.map((schedule, index) => ({ name: `job-${index}`, schedule, lastRun: null })) }), VIEWER);
    expect(text()).toContain("Declared schedule: Every 5 minutes (at most once per check)");
    expect(text()).toContain("Declared schedule: App-defined schedule");
    expect(text()).toContain("store's time zone");
    expect(text()).toContain("Due work is checked every 15 minutes");
    const disclosures = [...host.querySelectorAll<HTMLDetailsElement>("details")].filter((element) => element.querySelector("summary")?.textContent === "Technical schedule");
    expect(disclosures.map((element) => element.open)).toEqual([false, false]);
    expect(disclosures.map((element) => element.querySelector("code")?.textContent)).toEqual(expressions);
    await act(async () => setLocale("bn"));
    expect(text()).toContain("ঘোষিত সময়সূচি: প্রতি ৫ মিনিটে");
    expect(text()).toContain("কারিগরি সময়সূচি");
  });

  it("has no checkout functions section when the app implements none", async () => {
    await renderApp(detail(), VIEWER);
    expect(text()).not.toContain("Checkout functions");
  });

  it("marks what an update adds and explains the app waits for a Super Admin", async () => {
    await renderApp(
      detail({
        needsApproval: true,
        granted: grant({ scopes: ["read_orders"] }),
        added: grant({ scopes: ["read_customers"], allowedHosts: [], events: [], functions: [], publicRoutes: false, customFieldOwners: [] }),
      }),
      MANAGER,
    );

    expect(text()).toContain("Update needs approval");
    expect(text()).toContain("paused until a Super Admin approves it");
    const newRows = [...document.querySelectorAll("li")].filter((row) => row.textContent?.includes("New"));
    expect(newRows.map((row) => row.textContent)).toEqual([expect.stringContaining("View customers")]);
    expect(hasButton("Review update")).toBe(false);
  });

  it("offers activation only to a Super Admin and sends the revision and grant key it showed", async () => {
    await renderApp(detail(), MANAGER);
    expect(hasButton("Review and activate")).toBe(false);
    expect(text()).toContain("Only a Super Admin can activate apps.");

    act(() => root.unmount());
    root = createRoot(host);
    sdk.postApiV1AdminAppsByIdActivate.mockImplementation(() =>
      ok({ app: detail({ status: "active", revision: 4 }), hookError: "Couldn't reach the points service." }));
    await renderApp(detail(), [], true);
    await click(button("Review and activate"));

    expect(dialog().textContent).toContain("Activate Loyalty points?");
    expect(dialog().textContent).toContain("View customers");
    expect(dialog().textContent).toContain("Its changes are recorded as yours.");
    await click(button("Activate", dialog()));

    expect(sdk.postApiV1AdminAppsByIdActivate).toHaveBeenCalledWith({
      path: { id: "acme.loyalty" },
      body: { expectedRevision: 3, grantKey: "grant-key-v3" },
    });
    await vi.waitFor(() => expect(toasts.success).toHaveBeenCalledWith("App activated"));
    expect(toasts.warning).toHaveBeenCalledWith("Loyalty points reported a problem", expect.objectContaining({ description: "Couldn't reach the points service." }));
  });

  it("agrees to nothing when the app asks for no access: no 'what is listed' sentence under an empty list", async () => {
    const none = grant({ scopes: [], allowedHosts: [], events: [], functions: [], publicRoutes: false, customFieldOwners: [] });
    await renderApp(detail({ request: none, added: none, scopes: [] }), [], true);
    await click(button("Review and activate"));

    expect(dialog().textContent).toContain("This app doesn't ask for access to your store.");
    expect(dialog().textContent).not.toContain("what is listed");
    expect(dialog().textContent).not.toContain("recorded as yours");
  });

  it("refetches and asks to review again when the request changed meanwhile", async () => {
    sdk.postApiV1AdminAppsByIdActivate.mockImplementation(() => refused(409, { code: "installation_grant_changed" }));
    await renderApp(detail(), [], true);
    await click(button("Review and activate"));
    sdk.getApiV1AdminAppsById.mockClear();
    await click(button("Activate", dialog()));

    await vi.waitFor(() => expect(toasts.error).toHaveBeenCalledWith("Changed elsewhere, review again"));
    await vi.waitFor(() => expect(sdk.getApiV1AdminAppsById).toHaveBeenCalledWith({ path: { id: "acme.loyalty" } }));
  });

  it("keeps Activate off until the required settings are filled in", async () => {
    await renderApp(detail({ settings: { ...detail().settings, missing: ["points_per_taka"] } }), [], true);
    await click(button("Review and activate"));

    expect(dialog().textContent).toContain("Still needed: Points per taka.");
    expect(button("Activate", dialog()).disabled).toBe(true);
  });

  it("never shows a saved secret and sends it only when typed or removed", async () => {
    await renderApp(detail(), MANAGER);
    expect(input("api_key").type).toBe("password");
    expect(input("api_key").value).toBe("");
    expect(text()).toContain("Set");

    // An edit elsewhere: the secret is left out, so the saved one stays.
    await type(input("program_name"), "Acme points");
    let sent = await saveSettings();
    expect(sent).toEqual({
      path: { id: "acme.loyalty" },
      body: { expectedRevision: 3, values: { points_per_taka: 2, program_name: "Acme points", tiers: ["gold"] } },
    });

    await type(input("api_key"), "sk_live_new");
    sent = await saveSettings();
    expect(sent.body.values.api_key).toBe("sk_live_new");
    expect(sent.body.expectedRevision).toBe(4);
    expect(input("api_key").value).toBe("");

    await click(button("Remove saved value"));
    expect(text()).toContain("The saved value will be removed when you save.");
    sent = await saveSettings();
    expect(sent.body.values).toHaveProperty("api_key", null);
  });

  it("checks settings against the app's rules before saving", async () => {
    await renderApp(detail(), MANAGER);
    await type(input("points_per_taka"), "2.5");
    await click(button("Save", document.querySelector<HTMLElement>("[data-save-bar]")!));

    expect(sdk.putApiV1AdminAppsByIdSettings).not.toHaveBeenCalled();
    expect(text()).toContain("Enter a whole number.");
  });

  it("offers no turn off or uninstall for a bundled app that never ran", async () => {
    await renderApp(detail({ status: "installed", runtime: "bundled", activatedAt: null }), MANAGER, true);
    expect(hasButton("Uninstall")).toBe(false);
    expect(hasButton("Deactivate")).toBe(false);

    // Once it has run, uninstalling can delete its data: offered.
    act(() => root.unmount());
    queryClient.clear();
    root = createRoot(host);
    await renderApp(detail({ status: "disabled", runtime: "bundled", activatedAt: "2026-10-01T09:00:00.000Z" }), MANAGER, true);
    expect(hasButton("Uninstall")).toBe(true);
  });

  it("uninstalls keeping the data unless the merchant chooses to delete it", async () => {
    sdk.postApiV1AdminAppsByIdUninstall.mockImplementation(() => ok({ id: "acme.loyalty", uninstalled: true, keepData: false, hookError: null }));
    await renderApp(detail({ status: "active", activatedAt: "2026-10-01T09:00:00.000Z" }), MANAGER);
    await click(button("Uninstall"));

    expect(dialog().textContent).toContain("Uninstall Loyalty points?");
    expect(dialog().textContent).toContain("stays in your apps, ready to activate again");
    const deleteChoice = [...dialog().querySelectorAll("label")].find((label) => label.textContent?.includes("Delete its data"))!;
    await click(deleteChoice.querySelector<HTMLElement>('[role="radio"]')!);
    await click(button("Uninstall", dialog()));

    expect(sdk.postApiV1AdminAppsByIdUninstall).toHaveBeenCalledWith({
      path: { id: "acme.loyalty" },
      body: { expectedRevision: 3, keepData: false },
    });
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/admin/apps" }));
    expect(toasts.success).toHaveBeenCalledWith("App uninstalled");
  });

  it("deactivates with the revision it showed", async () => {
    sdk.postApiV1AdminAppsByIdDeactivate.mockImplementation(() => ok({ app: detail({ status: "disabled", revision: 4 }), hookError: null }));
    await renderApp(detail({ status: "active" }), MANAGER);
    expect(text()).toContain("Stops the app. Its settings and data stay, ready to activate again.");
    await click(button("Deactivate"));
    await click(button("Deactivate", dialog()));

    expect(sdk.postApiV1AdminAppsByIdDeactivate).toHaveBeenCalledWith({ path: { id: "acme.loyalty" }, body: { expectedRevision: 3 } });
    await vi.waitFor(() => expect(toasts.success).toHaveBeenCalledWith("App deactivated"));
  });

  it("lets managers send a failed event again", async () => {
    sdk.getApiV1AdminAppsByIdDeliveries.mockImplementation(() => ok({ deliveries: [delivery()], nextCursor: null }));
    sdk.postApiV1AdminAppsByIdDeliveriesByDeliveryIdRetry.mockImplementation(() => ok({ delivery: delivery({ status: "pending" }) }));
    await renderApp(detail({ status: "active" }), MANAGER);
    await vi.waitFor(() => expect(document.querySelector('button[aria-label^="Details for"]')).not.toBeNull());
    await click(document.querySelector<HTMLButtonElement>('button[aria-label^="Details for"]')!);

    expect(text()).toContain("Points service answered 500");
    await click(button("Send again"));
    expect(sdk.postApiV1AdminAppsByIdDeliveriesByDeliveryIdRetry).toHaveBeenCalledWith({ path: { id: "acme.loyalty", deliveryId: "pdl_1" } });
  });

  it("shows the app's log newest first, opens a line's fields and pages before the last line", async () => {
    const line = (id: string, overrides: Record<string, unknown> = {}) => ({
      id,
      level: "info",
      source: "event:order.created",
      message: `Line ${id}`,
      fields: {},
      createdAt: "2026-10-01T08:00:00.000Z",
      ...overrides,
    });
    sdk.getApiV1AdminAppsByIdLogs.mockImplementation(({ query }: { query: { before?: string } }) =>
      query.before === "log_2"
        ? ok({ lines: [line("log_1")], nextCursor: null })
        : ok({ lines: [line("log_3", { level: "error", fields: { orderId: "ord_9" } }), line("log_2")], nextCursor: "log_2" }));
    await renderApp(detail({ status: "active" }), VIEWER);
    const findLogTab = () => [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find((tab) => tab.textContent === "Log");
    await vi.waitFor(() => expect(findLogTab()).toBeDefined());
    const logTab = findLogTab()!;
    await act(async () => {
      logTab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    });
    await vi.waitFor(() => expect(text()).toContain("Line log_3"));

    expect(text()).toContain("Error");
    await click(button("Load more"));
    expect(sdk.getApiV1AdminAppsByIdLogs).toHaveBeenLastCalledWith({ path: { id: "acme.loyalty" }, query: { before: "log_2", limit: 50 } });
    await vi.waitFor(() => expect(text()).toContain("Line log_1"));
    await click(document.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')!);
    expect(text()).toContain('"orderId": "ord_9"');
  });

  it("is read-only without apps.manage: no turning off, no saving, no retry", async () => {
    sdk.getApiV1AdminAppsByIdDeliveries.mockImplementation(() => ok({ deliveries: [delivery()], nextCursor: null }));
    await renderApp(detail({ status: "active" }), VIEWER);
    await vi.waitFor(() => expect(document.querySelector('button[aria-label^="Details for"]')).not.toBeNull());

    expect(hasButton("Deactivate")).toBe(false);
    expect(hasButton("Uninstall")).toBe(false);
    expect(hasButton("Remove saved value")).toBe(false);
    expect(input("program_name").disabled).toBe(true);
    expect(input("api_key").disabled).toBe(true);
    expect(document.querySelector('[data-slot="read-only-notice"]')).not.toBeNull();
    await click(document.querySelector<HTMLButtonElement>('button[aria-label^="Details for"]')!);
    expect(text()).toContain("Points service answered 500");
    expect(hasButton("Send again")).toBe(false);
  });

  it("speaks Bangla", async () => {
    setLocale("bn");
    await renderApp(detail(), [], true);
    expect(text()).toContain("দেখে চালু করুন");
    expect(text()).toContain("স্টোরের তথ্য");
    expect(text()).toContain("চেকআউটে ডিসকাউন্ট দেওয়া");
  });

  it("names checkout functions in Bangla", async () => {
    setLocale("bn");
    await renderApp(detail({ functions: [{ point: "checkout.shipping_rates", priority: 3, reads: [] }] }), VIEWER);
    expect(text()).toContain("চেকআউট ফাংশন");
    expect(text()).toContain("ডেলিভারি অপশন বদলায়");
    expect(text()).toContain("প্রায়োরিটি ৩");
  });
});

/** A regional pack: one app-wide group, and two services with fields of their own. */
function pack(overrides: Record<string, unknown> = {}) {
  return detail({
    id: "acme.pack",
    name: "Acme pack",
    status: "active",
    settings: {
      fields: [
        field({ key: "store_code", label: "Store code", type: "text", group: "general" }),
        field({ key: "alpha_key", label: "API key", type: "secret", group: "alpha" }),
        field({ key: "alpha_sender", label: "Sender name", type: "text", group: "alpha" }),
        field({ key: "beta_token", label: "Token", type: "secret", group: "beta" }),
        field({ key: "beta_weight", label: "Default weight", type: "number", group: "beta" }),
      ],
      values: { store_code: "DHK-1", alpha_sender: "ACME", beta_weight: 0.5 },
      secrets: { alpha_key: true, beta_token: false },
      missing: [],
      sections: [{ group: { id: "general", title: "Store", description: "How the pack names your store." }, keys: ["store_code"] }],
    },
    providers: [
      { id: "acme.pack:alpha", providerId: "alpha", kind: "sms", name: "Alpha SMS", icon: null, settings: ["alpha_key", "alpha_sender"], own: true, required: ["alpha_key"] },
      { id: "acme.pack:beta", providerId: "beta", kind: "courier", name: "Beta Courier", icon: null, settings: ["beta_token", "beta_weight"], own: true, required: ["beta_token"] },
    ],
    ...overrides,
  });
}

describe("App page: sections", () => {
  it("opens on an overview: every service by kind with whether it is on, each a link to its own page", async () => {
    await renderApp(detail({ status: "active", features: [feature({ enabled: true, grantKey: null }), placesFeature()] }), MANAGER, true);
    // The section column: Overview, the features under their kind, then the app's own Settings and Activity.
    const nav = document.querySelector('nav[aria-label="Sections of Loyalty points"]')!;
    expect([...nav.querySelectorAll("a")].map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["Overview", "/admin/apps/acme.loyalty"],
      ["Bangladesh placesOff", "/admin/apps/acme.loyalty/places"],
      ["bKash", "/admin/apps/acme.loyalty/bkash"],
      ["Settings", "/admin/apps/acme.loyalty/settings"],
      ["Activity", "/admin/apps/acme.loyalty/activity"],
    ]);
    expect(nav.querySelector('[aria-current="page"]')?.textContent).toBe("Overview");
    // The health summary.
    expect(text()).toContain("1 of 2 on");
    const phoneOff = document.querySelector('[data-slot="services-off"]')!;
    const services = [...document.querySelectorAll<HTMLAnchorElement>('a[href^="/admin/apps/acme.loyalty/"]')]
      .filter((link) => !nav.contains(link) && !phoneOff.contains(link))
      .map((link) => link.getAttribute("href"));
    // The ones that are on; the rest stay in the column, counted here.
    expect(services).toEqual(["/admin/apps/acme.loyalty/bkash"]);
    expect(text()).toContain("1 more service is off. Choose it from the list to set it up.");
    // Below 1024px the column is a picker, so the card lists the off ones too (hidden from lg).
    expect(phoneOff.className).toContain("lg:hidden");
    expect([...phoneOff.querySelectorAll("a")].map((link) => link.getAttribute("href"))).toEqual(["/admin/apps/acme.loyalty/places"]);
    // No switch on the overview: each feature turns on on its own page.
    expect(document.querySelectorAll('button[role="switch"]')).toHaveLength(0);
    expect(text()).toContain("About");
    expect(text()).toContain("Turn off or uninstall");
  });

  it("summarises a pack with nothing on instead of repeating the column, and lists running services problems first", async () => {
    await renderApp(detail({ status: "active", features: [feature(), placesFeature()] }), MANAGER, true);
    const nav = document.querySelector('nav[aria-label="Sections of Loyalty points"]')!;
    const phoneOff = document.querySelector('[data-slot="services-off"]')!;
    const outside = () => [...document.querySelectorAll<HTMLAnchorElement>('a[href^="/admin/apps/acme.loyalty/"]')]
      .filter((link) => !nav.contains(link) && !phoneOff.contains(link));
    expect(text()).toContain("0 of 2 on");
    expect(text()).toContain("All 2 services are off. Choose one from the list to set it up.");
    expect(outside()).toHaveLength(0);

    act(() => root.unmount());
    queryClient.clear();
    root = createRoot(host);
    // bKash is on but misses a required setting; places is on and ready.
    const bkash = feature({ enabled: true, grantKey: null });
    const places = placesFeature();
    await renderApp(detail({
      status: "active",
      features: [{ ...places, enabled: true, grantKey: null }, bkash],
      providers: [{ id: "acme.loyalty:bkash", providerId: "bkash", kind: "payment", name: "bKash", icon: null, settings: ["bkash_app_key"], own: true, required: ["bkash_app_key"] }],
      settings: { ...detail().settings, fields: [...detail().settings.fields, field({ key: "bkash_app_key", label: "App key", type: "text" })] },
    }), MANAGER, true);
    expect(text()).toContain("1 service needs attention.");
    const rows = [...document.querySelectorAll<HTMLAnchorElement>('a[href^="/admin/apps/acme.loyalty/"]')]
      .filter((link) => !document.querySelector("nav")!.contains(link));
    expect(rows[0]?.textContent).toContain("bKash");
    expect(rows[0]?.textContent).toContain("Needs setup");
  });

  it("keeps an app without features on one page, with no section column", async () => {
    await renderApp(detail(), MANAGER);
    expect(document.querySelector("nav[aria-label^='Sections of']")).toBeNull();
    expect(text()).toContain("About");
  });

  it("asks a Super Admin to approve only that feature's access from its own page, and says it applies at once", async () => {
    sdk.postApiV1AdminAppsByIdFeaturesByFeatureIdEnable.mockImplementation(() =>
      ok({ app: detail({ status: "active", revision: 5, features: [feature({ enabled: true, grantKey: null }), placesFeature()] }), changed: true, hookError: null }));
    await renderApp(detail({ status: "active", features: [feature(), placesFeature()] }), MANAGER, true, "bkash");

    expect(document.querySelector('nav [aria-current="page"]')?.textContent).toContain("bKash");
    expect(text()).toContain("Turning it on or off applies right away, after you confirm.");
    expect(text()).toContain("Turn on bKash to set it up. Its settings then appear here.");
    expect(text()).toContain("tokenized.pay.bka.sh");
    const switches = [...document.querySelectorAll<HTMLButtonElement>('button[role="switch"]')];
    expect(switches.map((element) => element.getAttribute("aria-checked"))).toEqual(["false"]);
    await click(switches[0]!);

    expect(dialog().textContent).toContain("Turn on bKash?");
    expect(dialog().textContent).toContain("Take bKash payments at checkout.");
    expect(dialog().textContent).toContain("Takes payments");
    // Only this feature's access: not the places scope.
    expect(dialog().textContent).not.toContain("Load delivery places");
    await click(button("Turn on", dialog()));
    expect(sdk.postApiV1AdminAppsByIdFeaturesByFeatureIdEnable).toHaveBeenCalledWith({
      path: { id: "acme.loyalty", featureId: "bkash" },
      body: { expectedRevision: 3, grantKey: "feature-key-bkash" },
    });
    await vi.waitFor(() => expect(toasts.success).toHaveBeenCalledWith("bKash is on."));
  });

  it("says in one sentence that a feature needs nothing more, without a 'can:' list or a consent to nothing", async () => {
    const quiet = feature({
      request: { scopes: [], allowedHosts: [], providers: [], events: [], functions: [], publicRoutes: false, storefront: false, admin: false, cron: [] },
    });
    await renderApp(detail({ status: "active", features: [quiet, placesFeature()] }), MANAGER, true, "bkash");
    await click(document.querySelector<HTMLButtonElement>('button[role="switch"]')!);

    expect(dialog().textContent).toContain("bKash needs no access beyond what Loyalty points already has.");
    expect(dialog().textContent).not.toContain("can:");
    expect(dialog().textContent).not.toContain("recorded as yours");
  });

  it("lets a manager turn a feature off but not on, and says why", async () => {
    sdk.postApiV1AdminAppsByIdFeaturesByFeatureIdDisable.mockImplementation(() =>
      ok({ app: detail({ status: "active", revision: 4, features: [feature(), placesFeature()] }), changed: true, hookError: null }));
    const app = detail({ status: "active", features: [feature({ enabled: true, grantKey: null }), placesFeature()] });
    await renderApp(app, MANAGER, false, "places");
    expect(text()).toContain("Only a Super Admin can turn a feature on");
    expect(document.querySelector<HTMLButtonElement>('button[role="switch"]')!.disabled).toBe(true);

    act(() => root.unmount());
    root = createRoot(host);
    await renderApp(app, MANAGER, false, "bkash");
    await click(document.querySelector<HTMLButtonElement>('button[role="switch"]')!);
    expect(dialog().textContent).toContain("Turn off bKash?");
    // What stops for the store.
    expect(dialog().textContent).toContain("Buyers can no longer pay with it.");
    await click(button("Turn off", dialog()));
    expect(sdk.postApiV1AdminAppsByIdFeaturesByFeatureIdDisable).toHaveBeenCalledWith({
      path: { id: "acme.loyalty", featureId: "bkash" },
      body: { expectedRevision: 3 },
    });
    await vi.waitFor(() => expect(toasts.success).toHaveBeenCalledWith("bKash is off."));
  });

  it("keeps features off until the app is active, and says what each one would reach", async () => {
    await renderApp(detail({ features: [feature(), placesFeature()] }), MANAGER, true, "places");
    expect(text()).toContain("Activate the app first.");
    expect(document.querySelector<HTMLButtonElement>('button[role="switch"]')!.disabled).toBe(true);
    expect(text()).toContain("Load delivery places");
  });

  it("shows an on feature's own settings on its page, its health and where it is chosen, and saves them with the save bar", async () => {
    const bkashOn = feature({ enabled: true, grantKey: null, settings: ["bkash_app_key", "bkash_username"] });
    const app = (overrides: Record<string, unknown> = {}) => detail({
      status: "active",
      features: [bkashOn, placesFeature()],
      settings: {
        fields: [
          field({ key: "bkash_app_key", label: "App key", type: "secret", group: "bkash" }),
          field({ key: "bkash_username", label: "Username", type: "text", group: "bkash" }),
        ],
        values: { bkash_username: "shop" },
        secrets: { bkash_app_key: false },
        missing: [],
        sections: [],
      },
      providers: [{ id: "acme.loyalty:bkash", providerId: "bkash", kind: "payment", name: "bKash", icon: null, settings: ["bkash_app_key", "bkash_username"], own: true, required: ["bkash_app_key", "bkash_username"] }],
      ...overrides,
    });
    sdk.putApiV1AdminAppsByIdSettings.mockImplementation(() => ok({ app: app({ revision: 4 }) }));
    await renderApp(app(), MANAGER, true, "bkash");

    expect(input("bkash_app_key").type).toBe("password");
    expect(input("bkash_username").value).toBe("shop");
    expect(text()).toContain("Needs setup");
    // Turning it on offers it at checkout: no second switch to send the merchant to.
    expect(document.querySelector('a[href="/admin/settings/payments"]')).toBeNull();
    await type(input("bkash_username"), "my-shop");
    const sent = await saveSettings();
    expect(sent.body.values).toEqual({ bkash_username: "my-shop" });
  });

  it("calls a payment ready only while checkout offers it, and an SMS service only while it sends", async () => {
    const bkashOn = feature({ enabled: true, grantKey: null, settings: ["bkash_username"] });
    const settings = {
      fields: [field({ key: "bkash_username", label: "Username", type: "text", group: "bkash" })],
      values: { bkash_username: "shop" },
      secrets: {},
      missing: [],
      sections: [],
    };
    const bkash = { id: "acme.loyalty:bkash", providerId: "bkash", kind: "payment", name: "bKash", icon: null, settings: ["bkash_username"], own: true, required: ["bkash_username"] };
    const render = async (use: string, kind = "payment") => {
      act(() => root.unmount());
      queryClient.clear();
      root = createRoot(host);
      await renderApp(detail({ status: "active", features: [bkashOn, placesFeature()], settings, providers: [{ ...bkash, kind, use }] }), MANAGER, true, "bkash");
    };

    await render("offered");
    expect(text()).toContain("Ready");
    expect(document.querySelector('a[href="/admin/settings/payments"]')).toBeNull();

    await render("hidden");
    expect(text()).toContain("Hidden at checkout");
    expect(text()).not.toContain("Ready");
    expect(text()).toContain("it is hidden in Settings → Payments");
    expect(document.querySelector('a[href="/admin/settings/payments"]')?.textContent).toBe("Show it at checkout in Settings → Payments");

    await render("currency");
    expect(text()).toContain("Not offered at checkout");
    expect(text()).toContain("can't take payments in your store's currency");

    // An SMS provider set up while notifications send through another one.
    await render("not_chosen", "sms");
    expect(text()).toContain("Not used for sending");
    expect(document.querySelector('a[href="/admin/settings/notifications"]')?.textContent).toBe("Choose it in Settings → Notifications");
    await render("chosen", "sms");
    expect(text()).toContain("Ready");
    expect(document.querySelector('a[href="/admin/settings/notifications"]')).toBeNull();
  });

  it("calls a provider with a connection test ready only after a test passed, and tests only when asked", async () => {
    const bkashOn = feature({ enabled: true, grantKey: null, settings: ["bkash_username"] });
    const settings = {
      fields: [field({ key: "bkash_username", label: "Username", type: "text", group: "bkash" })],
      values: { bkash_username: "shop" },
      secrets: {},
      missing: [],
      sections: [],
    };
    const bkash = { id: "acme.loyalty:bkash", providerId: "bkash", kind: "payment", name: "bKash", icon: null, settings: ["bkash_username"], own: true, required: ["bkash_username"], use: "offered" };
    const withConnection = (connection: Record<string, unknown>) =>
      detail({ status: "active", features: [bkashOn, placesFeature()], settings, providers: [{ ...bkash, connection }] });
    sdk.postApiV1AdminSettingsProvidersByIdTest.mockImplementation(() => ok({ ok: false, message: "bKash refused the app key." }));
    await renderApp(withConnection({ status: "untested", testedAt: null, message: null }), MANAGER, true, "bkash");
    expect(text()).toContain("Set up (not tested)");
    expect(text()).not.toContain("Ready");
    // Loading the page never calls the provider.
    expect(sdk.postApiV1AdminSettingsProvidersByIdTest).not.toHaveBeenCalled();

    // Testing reads the page again: the stored outcome is the status.
    sdk.getApiV1AdminAppsById.mockImplementation(() => ok({ app: withConnection({ status: "failed", testedAt: "2026-10-19T08:00:00.000Z", message: "bKash refused the app key." }) }));
    await click(button("Test connection"));
    expect(sdk.postApiV1AdminSettingsProvidersByIdTest).toHaveBeenCalledWith({ path: { id: "acme.loyalty:bkash" } });
    await vi.waitFor(() => expect(text()).toContain("Connection failed"));
    expect(text()).toContain("bKash refused the app key.");
    expect(button("Test again")).toBeTruthy();

    act(() => root.unmount());
    queryClient.clear();
    root = createRoot(host);
    await renderApp(withConnection({ status: "passed", testedAt: "2026-10-19T08:00:00.000Z", message: null }), MANAGER, true, "bkash");
    expect(text()).toContain("Ready");
    expect(text()).toContain("Connection test passed");
  });

  it("says a feature's job failed, with when and why, on its page", async () => {
    await renderApp(detail({
      status: "active",
      features: [placesFeature(), feature()].map((entry, index) => (index === 0 ? { ...entry, enabled: true, grantKey: null } : entry)),
      admin: { pages: [{ id: "places", title: "Bangladesh places", placement: "settings", route: "places", tabs: null }], cards: [], actions: [], widgets: [] },
      cron: [{ name: "places_sync", schedule: "17 * * * *", lastRun: { scheduledFor: "2026-10-01T08:00:00.000Z", status: "failed", finishedAt: "2026-10-01T08:00:05.000Z", durationMs: 5000, error: "Pathao answered 503." } }],
    }), MANAGER, true, "places");
    expect(text()).toContain("Not working");
    expect(text()).toContain("Pathao answered 503.");
    expect(document.querySelector('a[href="/admin/apps/acme.loyalty/pages/places"]')?.textContent).toBe("Open Bangladesh places");
    // A feature's job shows with the feature, not as the app's own.
    expect(text()).not.toContain("Scheduled jobs");
  });

  it("names features in Bangla from the app's translations", async () => {
    setLocale("bn");
    try {
      await renderApp(detail({
        status: "active",
        features: [placesFeature()],
        translations: { bn: { features: { places: { name: "বাংলাদেশের এলাকা", description: "শহর, থানা ও এলাকা।" } } } },
      }), MANAGER, true, "places");
      expect(text()).toContain("বাংলাদেশের এলাকা");
      expect(text()).toContain("প্রস্তাবিত");
    } finally {
      setLocale("en");
    }
  });
});

describe("App page: settings and services", () => {
  it("is one page: no tabs, what it is and what it can reach beside its services", async () => {
    await renderApp(detail(), MANAGER);
    expect(document.querySelector('[role="tablist"][aria-label="App sections"]')).toBeNull();
    expect(text()).toContain("About");
    expect(text()).toContain("What this app can see and do in your store.");
    expect(text()).toContain("Version 1.2.0 · by Acme");
  });

  it("shows the app's own settings in their sections, and each service as a row with its own fields and status", async () => {
    sdk.getApiV1AdminAppsById.mockImplementation(() => ok({ app: pack() }));
    await render(<AppRoute id="acme.pack" />, MANAGER);
    await vi.waitFor(() => expect(text()).toContain("Acme pack"));

    expect(text()).toContain("How the pack names your store.");
    expect(input("store_code").value).toBe("DHK-1");
    // Each service in its kind's card, its fields under it, never named with a prefix.
    for (const key of ["alpha_key", "alpha_sender", "beta_token", "beta_weight"]) expect(input(key)).not.toBeNull();
    const rowOf = (name: string) => [...document.querySelectorAll("li")].find((row) => row.textContent?.startsWith(name))!;
    expect(rowOf("Alpha SMS").textContent).toContain("Ready");
    expect(rowOf("Beta Courier").textContent).toContain("Needs setup");
    expect(rowOf("Beta Courier").querySelector("a")?.getAttribute("href")).toBe("/admin/settings/shipping");
    expect(text()).toContain("SMS");
    expect(text()).toContain("Couriers");
    expect(document.querySelectorAll('button[role="switch"]')).toHaveLength(0);
  });

  it("saves a service's field with the page: every other field as last saved, no secret unless typed", async () => {
    sdk.getApiV1AdminAppsById.mockImplementation(() => ok({ app: pack() }));
    sdk.putApiV1AdminAppsByIdSettings.mockImplementation(() => ok({ app: pack({ revision: 4 }) }));
    await render(<AppRoute id="acme.pack" />, MANAGER);
    await vi.waitFor(() => expect(text()).toContain("Acme pack"));
    await type(input("alpha_sender"), "ACMEBD");
    const sent = await saveSettings();
    expect(sent).toEqual({
      path: { id: "acme.pack" },
      body: { expectedRevision: 3, values: { store_code: "DHK-1", alpha_sender: "ACMEBD", beta_weight: 0.5 } },
    });
  });
});


// ── Registry, upload, update, emergency stop and trusted developers ──

const registryApp = (overrides: Record<string, unknown> = {}) => ({
  registryId: "official",
  id: "acme.wrap",
  name: "Gift box",
  version: "1.1.0",
  tagline: "Box every order",
  description: "Boxes for your orders.",
  author: "Acme",
  signer: { keyId: "key_acme", name: "Acme Ltd", trusted: true, official: false },
  compatible: true,
  incompatibleReason: null,
  installed: null,
  updateAvailable: false,
  installCommand: "pnpm plugin add acme.wrap --registry https://registry.example/index.json",
  ...overrides,
});

const registryList = (overrides: Record<string, unknown> = {}) => ({
  officialConfigured: true,
  installMode: "dashboard",
  registries: [{ id: "official", name: "Scalius", official: true, status: "ok", error: null }],
  apps: [registryApp()],
  ...overrides,
});

const thirdParty = (overrides: Record<string, unknown> = {}) =>
  summary({ id: "acme.loyalty", source: "registry", thirdParty: true, signed: true, status: "active", ...overrides });

const LIST = (overrides: Record<string, unknown> = {}) => ({ apps: [thirdParty()], available: [], sandboxAvailable: true, ...overrides });

const settingsView = (overrides: Record<string, unknown> = {}) => ({
  revision: 2,
  officialConfigured: true,
  registries: [{ id: "partner", name: "Partner apps", indexUrl: "https://partner.example/index.json" }],
  trustedKeys: [
    { id: "key_official", name: "Scalius", publicKey: "OFFICIALKEYOFFICIALKEYOFFICIALKEYOFFICIALKEY1=", official: true },
    { id: "key_acme", name: "Acme Ltd", publicKey: "ACMEKEYACMEKEYACMEKEYACMEKEYACMEKEYACMEKEY12=", official: false },
  ],
  ...overrides,
});

async function chooseFile(name = "acme-loyalty.zip", size = 2048) {
  const picker = dialog().querySelector<HTMLInputElement>('input[type="file"]')!;
  const file = new File([new Uint8Array(size)], name, { type: "application/zip" });
  Object.defineProperty(picker, "files", { value: [file], configurable: true });
  await act(async () => {
    picker.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flush();
  return file;
}

async function openAppsMenuItem(label: string) {
  await vi.waitFor(() => expect(hasButton("More actions")).toBe(true));
  await chooseMenuItem(label);
}

/** A fresh page for a test that renders twice. */
function restart() {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  queryClient.clear();
}

const registryRowButton = (name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("li button")].find((element) => element.textContent?.includes(name))!;

describe("Registry apps in the Apps list", () => {
  it("does not read the registries until a view needs them", async () => {
    sdk.getApiV1AdminApps.mockImplementation(() => ok(LIST()));
    sdk.getApiV1AdminAppsRegistry.mockImplementation(() => ok(registryList()));
    await render(<AppsList />, VIEWER);
    await vi.waitFor(() => expect(text()).toContain("Loyalty points"));
    await vi.waitFor(() => expect(hasButton("More actions")).toBe(true));
    expect(sdk.getApiV1AdminAppsRegistry).not.toHaveBeenCalled();

    await click(tab("Add apps"));
    await vi.waitFor(() => expect(text()).toContain("Gift box"));
    expect(sdk.getApiV1AdminAppsRegistry).toHaveBeenCalledTimes(1);
  });

  it("lists registry apps beside the first-party ones, with who signed each", async () => {
    sdk.getApiV1AdminApps.mockImplementation(() => ok(LIST({ available: [listing()] })));
    sdk.getApiV1AdminAppsRegistry.mockImplementation(() => ok(registryList({
      apps: [
        registryApp(),
        registryApp({ id: "stranger.tool", name: "Mystery tool", signer: { keyId: "key_x", name: null, trusted: false, official: false } }),
        registryApp({ id: "acme.loyalty", name: "Loyalty points", installed: { version: "1.2.0", source: "registry" } }),
      ],
    })));
    await render(<AppsList />, VIEWER);
    await vi.waitFor(() => expect(text()).toContain("Loyalty points"));
    await click(tab("Add apps"));
    await vi.waitFor(() => expect(text()).toContain("Gift box"));

    const list = rows();
    expect(list[0]).toContain("Gift wrap");
    expect(list.find((row) => row.includes("Gift box"))).toContain("Verified developer");
    expect(list.find((row) => row.includes("Gift box"))).toContain("by Acme · Scalius");
    expect(list.find((row) => row.includes("Mystery tool"))).toContain("Unknown developer");
    // An installed app is not offered again.
    expect(list.some((row) => row.includes("Loyalty points"))).toBe(false);
  });

  it("says when the official registry is not set up and when a registry cannot be read", async () => {
    sdk.getApiV1AdminApps.mockImplementation(() => ok(LIST()));
    sdk.getApiV1AdminAppsRegistry.mockImplementation(() => ok(registryList({
      officialConfigured: false,
      registries: [
        { id: "official", name: "Scalius", official: true, status: "ok", error: null },
        { id: "partner", name: "Partner apps", official: false, status: "unavailable", error: "It answered 503." },
      ],
      apps: [],
    })));
    await render(<AppsList />, VIEWER);
    await vi.waitFor(() => expect(text()).toContain("Loyalty points"));
    await click(tab("Add apps"));
    await vi.waitFor(() => expect(text()).toContain("The official app registry is not set up yet."));
    expect(text()).toContain("Couldn't load apps from Partner apps: It answered 503.");
    expect(text()).toContain("No apps to install");
  });

  it("installs from the dashboard, then opens the app's page for the access review", async () => {
    sdk.getApiV1AdminApps.mockImplementation(() => ok(LIST()));
    sdk.getApiV1AdminAppsRegistry.mockImplementation(() => ok(registryList()));
    sdk.postApiV1AdminAppsRegistryInstall.mockImplementation(() => ok({ app: detail({ id: "acme.wrap", name: "Gift box", source: "registry" }) }));
    await render(<AppsList />, MANAGER);
    await vi.waitFor(() => expect(text()).toContain("Loyalty points"));
    await click(tab("Add apps"));
    await vi.waitFor(() => expect(text()).toContain("Gift box"));
    await click(registryRowButton("Gift box"));
    await vi.waitFor(() => expect(dialog()?.textContent).toContain("Install Gift box"));

    expect(dialog().textContent).toContain("Verified developer: Acme Ltd");
    await click(button("Install", dialog()));
    await vi.waitFor(() => expect(sdk.postApiV1AdminAppsRegistryInstall).toHaveBeenCalledTimes(1));
    expect(sdk.postApiV1AdminAppsRegistryInstall.mock.calls[0]![0]).toEqual({ body: { registryId: "official", id: "acme.wrap", version: "1.1.0" } });
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/admin/apps/$pluginId", params: { pluginId: "acme.wrap" } }));
  });

  it("warns about an unknown developer and does not offer the install", async () => {
    sdk.getApiV1AdminApps.mockImplementation(() => ok(LIST()));
    sdk.getApiV1AdminAppsRegistry.mockImplementation(() => ok(registryList({
      apps: [registryApp({ signer: { keyId: "key_x", name: null, trusted: false, official: false } })],
    })));
    await render(<AppsList />, MANAGER);
    await vi.waitFor(() => expect(text()).toContain("Loyalty points"));
    await click(tab("Add apps"));
    await vi.waitFor(() => expect(text()).toContain("Gift box"));
    await click(registryRowButton("Gift box"));
    await vi.waitFor(() => expect(dialog()?.textContent).toContain("Install Gift box"));

    expect(dialog().textContent).toContain("Unknown developer");
    expect(dialog().textContent).toContain("This store doesn't know who made this app.");
    expect(button("Install", dialog()).disabled).toBe(true);
  });

  it("offers no install for an app that needs a newer Scalius", async () => {
    sdk.getApiV1AdminApps.mockImplementation(() => ok(LIST()));
    sdk.getApiV1AdminAppsRegistry.mockImplementation(() => ok(registryList({
      apps: [registryApp({ compatible: false, incompatibleReason: "It needs Scalius 2.0.0." })],
    })));
    await render(<AppsList />, MANAGER);
    await vi.waitFor(() => expect(text()).toContain("Loyalty points"));
    await click(tab("Add apps"));
    await vi.waitFor(() => expect(text()).toContain("Gift box"));
    await click(registryRowButton("Gift box"));
    await vi.waitFor(() => expect(dialog()?.textContent).toContain("Install Gift box"));

    expect(dialog().textContent).toContain("Needs a newer Scalius");
    expect(dialog().textContent).toContain("It needs Scalius 2.0.0.");
    expect(hasButton("Install")).toBe(false);
  });

  it("shows the command and a copy button when the store installs by command", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    sdk.getApiV1AdminApps.mockImplementation(() => ok(LIST({ sandboxAvailable: false })));
    sdk.getApiV1AdminAppsRegistry.mockImplementation(() => ok(registryList({ installMode: "command" })));
    await render(<AppsList />, MANAGER);
    await vi.waitFor(() => expect(text()).toContain("Loyalty points"));
    await click(tab("Add apps"));
    await vi.waitFor(() => expect(text()).toContain("Gift box"));
    await click(registryRowButton("Gift box"));
    await vi.waitFor(() => expect(dialog()?.textContent).toContain("Install Gift box"));

    expect(dialog().querySelector("code")?.textContent).toBe("pnpm plugin add acme.wrap --registry https://registry.example/index.json");
    expect(dialog().textContent).toContain("Ask your developer to add this app to your store.");
    expect(dialog().textContent).toContain("The app appears here once they update your store.");
    expect(hasButton("Install")).toBe(false);
    await click(button("Copy command", dialog()));
    expect(writeText).toHaveBeenCalledWith("pnpm plugin add acme.wrap --registry https://registry.example/index.json");
  });
});

describe("Upload and emergency stop on the Apps list", () => {
  it("offers Upload app only to managers on a store that installs from the dashboard", async () => {
    sdk.getApiV1AdminApps.mockImplementation(() => ok(LIST()));
    await render(<AppsList />, VIEWER);
    await vi.waitFor(() => expect(hasButton("More actions")).toBe(true));
    expect(hasButton("Upload app")).toBe(false);

    restart();
    sdk.getApiV1AdminApps.mockImplementation(() => ok(LIST({ sandboxAvailable: false })));
    await render(<AppsList />, MANAGER);
    await vi.waitFor(() => expect(hasButton("More actions")).toBe(true));
    expect(hasButton("Upload app")).toBe(false);
  });

  it("installs an uploaded package signed by a trusted developer and opens its page", async () => {
    sdk.getApiV1AdminApps.mockImplementation(() => ok(LIST()));
    sdk.postApiV1AdminAppsUpload.mockImplementation(() => ok({ app: detail({ id: "acme.wrap" }), updated: false, rolledBack: false, error: null }));
    await render(<AppsList />, MANAGER);
    await vi.waitFor(() => expect(hasButton("Upload app")).toBe(true));
    await click(button("Upload app"));
    await vi.waitFor(() => expect(dialog()?.textContent).toContain("Upload an app"));
    expect(button("Upload", dialog()).disabled).toBe(true);

    const file = await chooseFile();
    expect(dialog().textContent).toContain("acme-loyalty.zip");
    await click(button("Upload", dialog()));
    await vi.waitFor(() => expect(sdk.postApiV1AdminAppsUpload).toHaveBeenCalledTimes(1));
    expect(sdk.postApiV1AdminAppsUpload.mock.calls[0]![0]).toEqual({ body: file, query: {} });
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/admin/apps/$pluginId", params: { pluginId: "acme.wrap" } }));
  });

  it("stops at a warning for a developer the store does not trust; a Super Admin can trust and install", async () => {
    sdk.getApiV1AdminApps.mockImplementation(() => ok(LIST()));
    sdk.postApiV1AdminAppsUpload
      .mockImplementationOnce(() => refused(422, { code: "signature_untrusted", keyId: "key_new", developer: "Newcomer Ltd" }))
      .mockImplementationOnce(() => ok({ app: detail({ id: "acme.wrap" }), updated: false, rolledBack: false, error: null }));
    await render(<AppsList />, MANAGER, true);
    await vi.waitFor(() => expect(hasButton("Upload app")).toBe(true));
    await click(button("Upload app"));
    await vi.waitFor(() => expect(dialog()?.textContent).toContain("Upload an app"));
    await chooseFile();
    await click(button("Upload", dialog()));
    await vi.waitFor(() => expect(dialog().textContent).toContain("Signed by Newcomer Ltd, who this store does not trust yet. Only trust developers you know."));

    await click(button("Trust developer and install", dialog()));
    await vi.waitFor(() => expect(sdk.postApiV1AdminAppsUpload).toHaveBeenCalledTimes(2));
    expect((sdk.postApiV1AdminAppsUpload.mock.calls[1]![0] as { query: unknown }).query).toEqual({ trustDeveloper: "true" });
    await vi.waitFor(() => expect(navigate).toHaveBeenCalled());
  });

  it("tells anyone else to ask a Super Admin instead of offering the choice", async () => {
    sdk.getApiV1AdminApps.mockImplementation(() => ok(LIST()));
    sdk.postApiV1AdminAppsUpload.mockImplementation(() => refused(422, { code: "signature_untrusted", keyId: "key_new", developer: "Newcomer Ltd" }));
    await render(<AppsList />, MANAGER);
    await vi.waitFor(() => expect(hasButton("Upload app")).toBe(true));
    await click(button("Upload app"));
    await vi.waitFor(() => expect(dialog()?.textContent).toContain("Upload an app"));
    await chooseFile();
    await click(button("Upload", dialog()));
    await vi.waitFor(() => expect(dialog().textContent).toContain("Ask a Super Admin to trust this developer and install the app."));
    expect(hasButton("Trust developer and install")).toBe(false);
    expect(hasButton("Upload")).toBe(false);
  });

  it("warns that an unsigned app could have been changed, and a Super Admin can install it anyway", async () => {
    sdk.getApiV1AdminApps.mockImplementation(() => ok(LIST()));
    sdk.postApiV1AdminAppsUpload
      .mockImplementationOnce(() => refused(422, { code: "signature_missing" }))
      .mockImplementationOnce(() => ok({ app: detail({ id: "acme.wrap", signer: null }), updated: false, rolledBack: false, error: null }));
    await render(<AppsList />, MANAGER, true);
    await vi.waitFor(() => expect(hasButton("Upload app")).toBe(true));
    await click(button("Upload app"));
    await vi.waitFor(() => expect(dialog()?.textContent).toContain("Upload an app"));
    await chooseFile();
    await click(button("Upload", dialog()));
    await vi.waitFor(() => expect(dialog().textContent).toContain("This app is not signed. Anyone could have changed it."));

    await click(button("Install unsigned app", dialog()));
    await vi.waitFor(() => expect(sdk.postApiV1AdminAppsUpload).toHaveBeenCalledTimes(2));
    expect((sdk.postApiV1AdminAppsUpload.mock.calls[1]![0] as { query: unknown }).query).toEqual({ allowUnsigned: "true" });
  });

  it("refuses a file that is not a zip before sending anything", async () => {
    sdk.getApiV1AdminApps.mockImplementation(() => ok(LIST()));
    await render(<AppsList />, MANAGER);
    await vi.waitFor(() => expect(hasButton("Upload app")).toBe(true));
    await click(button("Upload app"));
    await vi.waitFor(() => expect(dialog()?.textContent).toContain("Upload an app"));
    await chooseFile("notes.txt");
    expect(dialog().textContent).toContain("Choose a .zip file.");
    expect(button("Upload", dialog()).disabled).toBe(true);
    expect(sdk.postApiV1AdminAppsUpload).not.toHaveBeenCalled();
  });

  it("stops every third-party app after a confirmation that counts them", async () => {
    sdk.getApiV1AdminApps.mockImplementation(() => ok(LIST({
      apps: [thirdParty(), thirdParty({ id: "acme.sms", name: "SMS alerts" }), summary({ id: "scalius.bkash", name: "bKash", status: "active" })],
    })));
    sdk.postApiV1AdminAppsStopThirdParty.mockImplementation(() => ok({ stopped: ["acme.loyalty", "acme.sms"] }));
    await render(<AppsList />, MANAGER);
    await openAppsMenuItem("Stop all third-party apps");
    await vi.waitFor(() => expect(dialog()?.textContent).toContain("Stop 2 third-party apps?"));
    expect(sdk.postApiV1AdminAppsStopThirdParty).not.toHaveBeenCalled();

    await click(button("Stop all", dialog()));
    await vi.waitFor(() => expect(sdk.postApiV1AdminAppsStopThirdParty).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(toasts.success).toHaveBeenCalledWith("2 apps stopped"));
  });

  it("offers the emergency stop only to managers", async () => {
    sdk.getApiV1AdminApps.mockImplementation(() => ok(LIST()));
    await render(<AppsList />, VIEWER);
    await vi.waitFor(() => expect(hasButton("More actions")).toBe(true));
    await act(async () => {
      button("More actions").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    });
    await flush();
    const items = [...document.querySelectorAll('[role="menuitem"]')].map((element) => element.textContent?.trim());
    expect(items).toEqual(["Registries and trusted developers"]);
  });
});

describe("Registries and trusted developers", () => {
  it("lets a Super Admin add a registry and a developer, and saves with the revision shown", async () => {
    sdk.getApiV1AdminApps.mockImplementation(() => ok(LIST()));
    sdk.getApiV1AdminAppsRegistrySettings.mockImplementation(() => ok(settingsView()));
    sdk.putApiV1AdminAppsRegistrySettings.mockImplementation(() => ok(settingsView({ revision: 3 })));
    await render(<AppsList />, MANAGER, true);
    await openAppsMenuItem("Registries and trusted developers");
    await vi.waitFor(() => expect(dialog()?.textContent).toContain("Scalius official registry"));
    expect([...dialog().querySelectorAll<HTMLInputElement>("input")].map((field) => field.value)).toContain("Partner apps");
    expect(dialog().textContent).toContain("Key id: key_acme");
    // The official key is shown, never editable.
    expect(dialog().textContent).toContain("Scalius (official)");

    const fields = () => [...dialog().querySelectorAll<HTMLInputElement>("input")];
    await click(button("Add registry", dialog()));
    await type(fields().find((field) => field.id.includes("-r") && field.id.endsWith("-name") && field.value === "")!, "Agency apps");
    await type(fields().find((field) => field.value === "https://")!, "https://agency.example/index.json");
    await click(button("Add developer", dialog()));
    await type(fields().find((field) => field.id.includes("-k") && field.id.endsWith("-name") && field.value === "")!, "Agency Ltd");
    await type(fields().find((field) => field.id.includes("-k") && field.id.endsWith("-key") && field.value === "")!, "AGENCYKEYAGENCYKEYAGENCYKEYAGENCYKEYAGEN12=");
    await click(button("Save", dialog()));

    await vi.waitFor(() => expect(sdk.putApiV1AdminAppsRegistrySettings).toHaveBeenCalledTimes(1));
    expect(sdk.putApiV1AdminAppsRegistrySettings.mock.calls[0]![0]).toEqual({
      body: {
        expectedRevision: 2,
        registries: [
          { id: "partner", name: "Partner apps", indexUrl: "https://partner.example/index.json" },
          { id: "agency-apps", name: "Agency apps", indexUrl: "https://agency.example/index.json" },
        ],
        trustedKeys: [
          { name: "Acme Ltd", publicKey: "ACMEKEYACMEKEYACMEKEYACMEKEYACMEKEYACMEKEY12=" },
          { name: "Agency Ltd", publicKey: "AGENCYKEYAGENCYKEYAGENCYKEYAGENCYKEYAGEN12=" },
        ],
      },
    });
    await vi.waitFor(() => expect(toasts.success).toHaveBeenCalledWith("Registries saved"));
  });

  it("refuses an address that is not https before saving", async () => {
    sdk.getApiV1AdminApps.mockImplementation(() => ok(LIST()));
    sdk.getApiV1AdminAppsRegistrySettings.mockImplementation(() => ok(settingsView()));
    await render(<AppsList />, MANAGER, true);
    await openAppsMenuItem("Registries and trusted developers");
    await vi.waitFor(() => expect(dialog()?.textContent).toContain("Scalius official registry"));
    const url = [...dialog().querySelectorAll<HTMLInputElement>("input")].find((field) => field.value.startsWith("https://partner"))!;
    await type(url, "http://partner.example/index.json");
    await click(button("Save", dialog()));
    expect(dialog().textContent).toContain("Use an address that starts with https://");
    expect(sdk.putApiV1AdminAppsRegistrySettings).not.toHaveBeenCalled();
  });

  it("shows everyone else the same lists read-only", async () => {
    sdk.getApiV1AdminApps.mockImplementation(() => ok(LIST()));
    sdk.getApiV1AdminAppsRegistrySettings.mockImplementation(() => ok(settingsView()));
    await render(<AppsList />, VIEWER);
    await openAppsMenuItem("Registries and trusted developers");
    await vi.waitFor(() => expect(dialog()?.textContent).toContain("Partner apps"));

    expect(dialog().textContent).toContain("Only a Super Admin can change these.");
    expect(dialog().textContent).toContain("Acme Ltd");
    expect(dialog().querySelectorAll("input")).toHaveLength(0);
    expect(hasButton("Save")).toBe(false);
    expect(hasButton("Add registry")).toBe(false);
  });
});

describe("App page lifecycle", () => {
  it("stops an active app at once after a confirmation", async () => {
    sdk.postApiV1AdminAppsByIdStop.mockImplementation(() => ok({ app: detail({ status: "disabled", failureReason: "Stopped with the emergency switch." }), stopped: true }));
    await renderApp(detail({ status: "active", source: "registry", thirdParty: true }), MANAGER);
    await vi.waitFor(() => expect(hasButton("Stop now")).toBe(true));
    await click(button("Stop now"));
    await vi.waitFor(() => expect(dialog()?.textContent).toContain("Stop Loyalty points now?"));
    expect(dialog().textContent).toContain("Stops the app at once without running its code. Its data and settings stay. A Super Admin starts it again.");
    expect(sdk.postApiV1AdminAppsByIdStop).not.toHaveBeenCalled();

    await click(button("Stop now", dialog()));
    await vi.waitFor(() => expect(sdk.postApiV1AdminAppsByIdStop).toHaveBeenCalledWith({ path: { id: "acme.loyalty" } }));
    await vi.waitFor(() => expect(toasts.success).toHaveBeenCalledWith("App stopped"));
  });

  it("offers Stop now only to managers, for a third-party app while it is active", async () => {
    await renderApp(detail({ status: "active", thirdParty: true }), VIEWER);
    expect(hasButton("Stop now")).toBe(false);
    restart();
    await renderApp(detail({ status: "active" }), MANAGER);
    expect(hasButton("Stop now")).toBe(false);
  });

  it("shows why a stopped app is off, with the way to start it again for a Super Admin", async () => {
    await renderApp(detail({ status: "disabled", source: "registry", failureReason: "Stopped automatically: it went over its limits 3 times within an hour." }), MANAGER, true);
    await vi.waitFor(() => expect(text()).toContain("This app is stopped"));
    expect(text()).toContain("Stopped automatically: it went over its limits 3 times within an hour.");
    expect(text()).toContain("To start it again, a Super Admin reviews and activates it.");
    expect(hasButton("Review and activate")).toBe(true);
    expect(hasButton("Stop now")).toBe(false);
  });

  it("offers the newer registry version and updates with the revision shown", async () => {
    sdk.getApiV1AdminAppsRegistry.mockImplementation(() => ok(registryList({
      apps: [registryApp({ id: "acme.loyalty", version: "1.3.0", installed: { version: "1.2.0", source: "registry" }, updateAvailable: true })],
    })));
    sdk.postApiV1AdminAppsByIdUpdate.mockImplementation(() => ok({ app: detail({ version: "1.3.0", revision: 4 }), rolledBack: false, error: null }));
    await renderApp(detail({ status: "active", source: "registry" }), MANAGER);
    await vi.waitFor(() => expect(hasButton("Update to 1.3.0")).toBe(true));
    expect(text()).toContain("Version 1.3.0 is available");

    await click(button("Update to 1.3.0"));
    await vi.waitFor(() => expect(sdk.postApiV1AdminAppsByIdUpdate).toHaveBeenCalledTimes(1));
    expect(sdk.postApiV1AdminAppsByIdUpdate.mock.calls[0]![0]).toEqual({
      path: { id: "acme.loyalty" },
      body: { expectedRevision: 3, registryId: "official", version: "1.3.0" },
    });
    await vi.waitFor(() => expect(toasts.success).toHaveBeenCalledWith("App updated"));
  });

  it("says plainly that an update was undone and why", async () => {
    sdk.getApiV1AdminAppsRegistry.mockImplementation(() => ok(registryList({
      apps: [registryApp({ id: "acme.loyalty", version: "1.3.0", installed: { version: "1.2.0", source: "registry" }, updateAvailable: true })],
    })));
    sdk.postApiV1AdminAppsByIdUpdate.mockImplementation(() => ok({ app: detail({ source: "registry" }), rolledBack: true, error: "Data update 2 failed." }));
    await renderApp(detail({ status: "active", source: "registry" }), MANAGER);
    await vi.waitFor(() => expect(hasButton("Update to 1.3.0")).toBe(true));
    await click(button("Update to 1.3.0"));
    await vi.waitFor(() => expect(text()).toContain("The update was undone: Data update 2 failed."));
  });

  it("offers no update for a bundled app or to someone who cannot manage apps", async () => {
    sdk.getApiV1AdminAppsRegistry.mockImplementation(() => ok(registryList({
      apps: [registryApp({ id: "acme.loyalty", version: "1.3.0", installed: { version: "1.2.0", source: "registry" }, updateAvailable: true })],
    })));
    await renderApp(detail({ source: "bundled" }), MANAGER);
    expect(hasButton("Update to 1.3.0")).toBe(false);
    expect(sdk.getApiV1AdminAppsRegistry).not.toHaveBeenCalled();

    restart();
    await renderApp(detail({ source: "registry" }), VIEWER);
    expect(hasButton("Update to 1.3.0")).toBe(false);
    expect(sdk.getApiV1AdminAppsRegistry).not.toHaveBeenCalled();
  });

  it("shows who signed the code, its storage, its limits and its data updates", async () => {
    await renderApp(detail({
      source: "registry",
      runtime: "sandbox",
      signer: { keyId: "key_acme", name: "Acme Ltd", official: false },
      storageUsage: { bytes: 2 * 1024 * 1024, measuredAt: "2026-10-07T00:00:00.000Z" },
      limits: { cpuMs: 50, wallMs: 1500, subrequests: 20, invocationsPerMinute: 60, storageBytes: 10 * 1024 * 1024 },
      migrations: { declared: [{ version: 1, description: "Add tiers" }, { version: 2, description: "Backfill" }], applied: 1 },
    }), VIEWER);
    await vi.waitFor(() => expect(text()).toContain("Verified developer: Acme Ltd"));

    expect(text()).toContain("2 MB of 10 MB");
    expect(text()).toContain("Up to 50 ms of work and 1.5 s in total, 20 calls, 60 runs a minute");
    expect(text()).toContain("1 of 2");
  });

  it("calls an upload without a signature an unsigned upload, and says nothing for bundled code", async () => {
    await renderApp(detail({ source: "upload", runtime: "sandbox", signer: null }), VIEWER);
    await vi.waitFor(() => expect(text()).toContain("Unsigned upload"));

    restart();
    await renderApp(detail({ source: "bundled" }), VIEWER);
    expect(text()).not.toContain("Unsigned upload");
    expect(text()).not.toContain("Verified developer");
    expect(text()).not.toContain("Storage used");
  });
});
