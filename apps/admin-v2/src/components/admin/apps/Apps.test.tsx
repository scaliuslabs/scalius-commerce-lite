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
}));
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
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
  Promise.resolve({ error: { success: false, error: { code: "PLUGIN_ERROR", message: "Refused.", details } }, response: { status } });

const grant = (overrides: Record<string, unknown> = {}) => ({
  permissions: ["customers.view", "orders.view"],
  allowedHosts: ["api.acme.example"],
  events: ["order.created"],
  functions: ["checkout.discounts"],
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
    functions: [],
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
    permissions: [
      { name: "customers.view", risk: "read", sensitive: true },
      { name: "orders.view", risk: "read", sensitive: false },
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
    storefront: { proxy: false, head: false, sections: [], productBlocks: [], scripts: [] },
    admin: { pages: [], cards: [], actions: [], widgets: [] },
    limits: { cpuMs: 50, wallMs: 1000, subrequests: 20, invocationsPerMinute: 60, storageBytes: 10 * 1024 * 1024 },
    storageUsage: { bytes: 0, measuredAt: null },
    signer: null,
    migrations: { declared: [], applied: 0 },
    ...overrides,
  };
}

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
function AppRoute({ id }: { id: string }) {
  const { data } = useQuery(appQueryOptions(id));
  return data ? <AppDetailPage app={data} /> : null;
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

async function renderApp(app: object, permissions: string[], isSuperAdmin = false) {
  sdk.getApiV1AdminAppsById.mockImplementation(() => ok({ app }));
  await render(<AppRoute id="acme.loyalty" />, permissions, isSuperAdmin);
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
  it("shows every app with its icon, status, tagline and countries, and links to its page", async () => {
    sdk.getApiV1AdminApps.mockImplementation(() => ok(STORE));
    await render(<AppsList />, VIEWER);
    await vi.waitFor(() => expect(text()).toContain("ERP sync"));

    const list = rows();
    expect(list[0]).toContain("Loyalty points");
    expect(list[0]).toContain("Active");
    expect(list[0]).toContain("Points that bring buyers back");
    expect(list[1]).toContain("Available in Bangladesh");
    // No tagline: the description stands in.
    expect(list[2]).toContain("Not active");
    expect(list[2]).toContain("Texts buyers when orders ship.");
    expect(list[3]).toContain("Update available");
    expect(list[4]).toContain("Off");
    expect(list[5]).toContain("Failed");
    expect(list[6]).toContain("Gift wrap");
    expect(list[6]).toContain("Not installed");
    // Countries show only when an app serves some of them.
    expect(list.filter((row) => row.includes("Available in"))).toHaveLength(1);
    expect(document.querySelector('a[href="/admin/apps/acme.erp"]')?.textContent).toContain("ERP sync");
    const bkashIcon = document.querySelector('a[href="/admin/apps/scalius.bkash"] img');
    expect(bkashIcon?.getAttribute("src")).toBe("/api/v1/admin/apps/scalius.bkash/assets/icon?v=63a5ccd16b4c0000");
    expect(bkashIcon?.getAttribute("alt")).toBe("");
  });

  it("counts each view and shows only its apps", async () => {
    sdk.getApiV1AdminApps.mockImplementation(() => ok(STORE));
    await render(<AppsList />, VIEWER);
    await vi.waitFor(() => expect(text()).toContain("ERP sync"));

    expect([...document.querySelectorAll('[role="tab"]')].map((element) => element.textContent)).toEqual([
      "All7", "Active2", "Installed, not active3", "Updates available1", "Available to install1",
    ]);
    await click(tab("Installed, not active"));
    expect(rows()).toHaveLength(3);
    expect(text()).toContain("Product feed");
    expect(text()).not.toContain("Photo reviews");
    await click(tab("Updates available"));
    expect(rows()).toHaveLength(1);
    expect(text()).toContain("Photo reviews");
    expect(tab("Updates available").getAttribute("aria-selected")).toBe("true");
  });

  it("searches names, taglines and category names, and clears the filters when nothing matches", async () => {
    sdk.getApiV1AdminApps.mockImplementation(() => ok(STORE));
    await render(<AppsList />, VIEWER);
    await vi.waitFor(() => expect(text()).toContain("ERP sync"));
    const search = document.querySelector<HTMLInputElement>('input[aria-label="Search apps"]')!;

    await type(search, "bkash");
    expect(rows()).toHaveLength(1);
    await type(search, "gifts");
    expect(rows().map((row) => row.slice(0, 9))).toEqual(["Gift wrap"]);
    await type(search, "customer loyalty");
    expect(rows()).toHaveLength(1);
    expect(text()).toContain("Loyalty points");

    await type(search, "nothing like this");
    expect(text()).toContain("No apps match these filters");
    await click(button("Clear filters"));
    expect(search.value).toBe("");
    expect(rows()).toHaveLength(7);
  });

  it("offers only the categories its apps use, and filters by one", async () => {
    sdk.getApiV1AdminApps.mockImplementation(() => ok(STORE));
    await render(<AppsList />, VIEWER);
    await vi.waitFor(() => expect(text()).toContain("ERP sync"));
    const trigger = document.querySelector<HTMLButtonElement>('button[aria-label="Category"]')!;
    expect(trigger.textContent).toContain("All categories");

    await click(trigger);
    const options = [...document.querySelectorAll('[role="option"]')].map((option) => option.textContent);
    expect(options).toEqual(["All categories", "Payments", "Orders", "Marketing", "Customer loyalty", "Notifications", "Operations"]);
    await click([...document.querySelectorAll<HTMLElement>('[role="option"]')].find((option) => option.textContent === "Marketing")!);
    expect(rows().map((row) => row.slice(0, 13))).toEqual(["Loyalty point", "Photo reviews"]);
  });

  it("opens an available app's listing with the command that adds it", async () => {
    sdk.getApiV1AdminApps.mockImplementation(() => ok(STORE));
    await render(<AppsList />, VIEWER);
    await vi.waitFor(() => expect(text()).toContain("Gift wrap"));

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

  it("says what appears here when nothing is installed", async () => {
    sdk.getApiV1AdminApps.mockImplementation(() => ok({ apps: [], available: [], sandboxAvailable: false }));
    await render(<AppsList />, VIEWER);
    await vi.waitFor(() => expect(text()).toContain("No apps installed"));
  });

  it("speaks Bangla, the app's own text included", async () => {
    setLocale("bn");
    sdk.getApiV1AdminApps.mockImplementation(() => ok({
      ...STORE,
      apps: [summary({ id: "scalius.bkash", name: "bKash", tagline: "Take bKash payments", categories: ["payments"], countries: ["BD"], translations: { bn: { name: "বিকাশ", tagline: "চেকআউটে বিকাশ পেমেন্ট নিন" } } })],
    }));
    await render(<AppsList />, VIEWER);
    await vi.waitFor(() => expect(text()).toContain("বিকাশ"));
    expect(text()).toContain("চেকআউটে বিকাশ পেমেন্ট নিন");
    expect(text()).toContain("ইনস্টল করা যায়");
    expect(text()).toContain("যেসব দেশে চলে:");
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
        added: grant({ permissions: [], allowedHosts: [], events: [], functions: [], publicRoutes: false, customFieldOwners: [], storefrontConnect: ["reviews.acme.example"] }),
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
          { point: "cart.validate", priority: 5, onError: "block", snapshotCollection: null },
          { point: "checkout.discounts", priority: 10, onError: "skip", snapshotCollection: "balances" },
        ],
      }),
      VIEWER,
    );
    expect(text()).toContain("Can pause checkout when it can't answer: Check carts");
    expect(text()).toContain("Reads and updates each signed-in buyer's \"balances\" record with their order");
  });

  it("lists its checkout functions in plain words with their priority, in checkout order", async () => {
    await renderApp(
      detail({
        functions: [
          { point: "order.risk", priority: 20 },
          { point: "cart.validate", priority: 5 },
          { point: "checkout.discounts", priority: 10 },
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
      "Rates new orders' risk (advice only)Priority 20",
    ]);
  });

  it("has no checkout functions section when the app implements none", async () => {
    await renderApp(detail(), VIEWER);
    expect(text()).not.toContain("Checkout functions");
  });

  it("marks what an update adds and explains the app waits for a Super Admin", async () => {
    await renderApp(
      detail({
        needsApproval: true,
        granted: grant({ permissions: ["orders.view"] }),
        added: grant({ permissions: ["customers.view"], allowedHosts: [], events: [], functions: [], publicRoutes: false, customFieldOwners: [] }),
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

  it("refetches and asks to review again when the request changed meanwhile", async () => {
    sdk.postApiV1AdminAppsByIdActivate.mockImplementation(() => refused(409, { code: "installation.grant_changed" }));
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

  it("uninstalls keeping the data unless the merchant chooses to delete it", async () => {
    sdk.postApiV1AdminAppsByIdUninstall.mockImplementation(() => ok({ id: "acme.loyalty", uninstalled: true, keepData: false, hookError: null }));
    await renderApp(detail({ status: "active", activatedAt: "2026-10-01T09:00:00.000Z" }), MANAGER);
    await chooseMenuItem("Uninstall");

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
    await chooseMenuItem("Deactivate");
    await click(button("Deactivate", dialog()));

    expect(sdk.postApiV1AdminAppsByIdDeactivate).toHaveBeenCalledWith({ path: { id: "acme.loyalty" }, body: { expectedRevision: 3 } });
    await vi.waitFor(() => expect(toasts.success).toHaveBeenCalledWith("App deactivated"));
  });

  it("lets managers send a failed event again", async () => {
    sdk.getApiV1AdminAppsByIdDeliveries.mockImplementation(() => ok({ deliveries: [delivery()], nextCursor: null }));
    sdk.postApiV1AdminAppsByIdDeliveriesByDeliveryIdRetry.mockImplementation(() => ok({ delivery: delivery({ status: "queued" }) }));
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
    const logTab = [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find((tab) => tab.textContent === "Log")!;
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

  it("is read-only without apps.manage: no menu, no saving, no retry", async () => {
    sdk.getApiV1AdminAppsByIdDeliveries.mockImplementation(() => ok({ deliveries: [delivery()], nextCursor: null }));
    await renderApp(detail({ status: "active" }), VIEWER);
    await vi.waitFor(() => expect(document.querySelector('button[aria-label^="Details for"]')).not.toBeNull());

    expect(hasButton("More actions")).toBe(false);
    expect(hasButton("Remove saved value")).toBe(false);
    expect(input("program_name").disabled).toBe(true);
    expect(input("api_key").disabled).toBe(true);
    expect(text()).toContain("Ask the store owner for access to change it.");
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
    await renderApp(detail({ functions: [{ point: "checkout.shipping_rates", priority: 3 }] }), VIEWER);
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

describe("App page: settings and services", () => {
  it("has Overview, Settings and Permissions tabs", async () => {
    await renderApp(detail(), MANAGER);
    const tabs = document.querySelector('[role="tablist"][aria-label="App sections"]')!;
    expect([...tabs.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)).toEqual(["Overview", "Settings", "Permissions"]);
  });

  it("shows only app-wide settings in the sections the app declares, each service as a collapsed group with its status", async () => {
    sdk.getApiV1AdminAppsById.mockImplementation(() => ok({ app: pack() }));
    await render(<AppRoute id="acme.pack" />, MANAGER);
    await vi.waitFor(() => expect(text()).toContain("Acme pack"));

    expect(text()).toContain("How the pack names your store.");
    expect(input("store_code").value).toBe("DHK-1");
    // A service's fields are never on the app page itself, nor named with a prefix.
    for (const key of ["alpha_key", "alpha_sender", "beta_token", "beta_weight"]) expect(input(key)).toBeNull();
    expect(text()).toContain("Services");
    const triggers = [...document.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")].filter((element) => element.closest('[data-slot="accordion-item"]'));
    expect(triggers.map((trigger) => trigger.textContent)).toEqual([
      expect.stringContaining("Alpha SMS"),
      expect.stringContaining("Beta Courier"),
    ]);
    expect(triggers[0]!.textContent).toContain("Configured");
    expect(triggers[1]!.textContent).toContain("Not set");
    expect(triggers.every((trigger) => trigger.getAttribute("aria-expanded") === "false")).toBe(true);
    // Open: each field reads Set or Not set, and the service links to where it is used.
    await click(triggers[1]!);
    expect(triggers[1]!.getAttribute("aria-expanded")).toBe("true");
    const group = triggers[1]!.closest('[data-slot="accordion-item"]')!;
    expect(group.textContent).toContain("TokenNot set");
    expect(group.textContent).toContain("Default weightSet");
    expect(group.querySelector("a")?.getAttribute("href")).toBe("/admin/settings/shipping");
  });

  it("opens a service's setup sheet with only its own fields, never a saved secret, and saves through the app", async () => {
    sdk.getApiV1AdminAppsById.mockImplementation(() => ok({ app: pack() }));
    sdk.putApiV1AdminAppsByIdSettings.mockImplementation(({ body }: { body: { values: Record<string, unknown> } }) =>
      ok({ app: pack({ revision: 4, settings: { ...pack().settings, values: { ...pack().settings.values, alpha_sender: body.values.alpha_sender } } }) }));
    await render(<AppRoute id="acme.pack" />, MANAGER);
    await vi.waitFor(() => expect(text()).toContain("Acme pack"));
    const trigger = [...document.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")].find((element) => element.textContent?.includes("Alpha SMS"))!;
    await click(trigger);
    await click(button("Edit Alpha SMS settings"));
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')?.textContent).toContain("by Acme pack"));

    const sheet = dialog();
    const ids = [...sheet.querySelectorAll("input")].map((element) => element.id).filter(Boolean);
    expect(ids).toEqual(["provider-setting-alpha_key", "provider-setting-alpha_sender"]);
    const secret = sheet.querySelector<HTMLInputElement>("#provider-setting-alpha_key")!;
    expect(secret.type).toBe("password");
    expect(secret.value).toBe("");
    expect(sheet.textContent).toContain("Configured");
    expect(sheet.textContent).not.toContain("Token");

    await type(sheet.querySelector<HTMLInputElement>("#provider-setting-alpha_sender")!, "ACMEBD");
    await click(button("Save", sheet));
    await vi.waitFor(() => expect(sdk.putApiV1AdminAppsByIdSettings).toHaveBeenCalledTimes(1));
    // This service's field as edited; every other field as last saved; no secret unless typed.
    expect(sdk.putApiV1AdminAppsByIdSettings.mock.calls[0]![0]).toEqual({
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

    await click(tab("Available to install"));
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
    await click(tab("Available to install"));
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
    await click(tab("Available to install"));
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
    await click(tab("Available to install"));
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
    await click(tab("Available to install"));
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
    await click(tab("Available to install"));
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
    await click(tab("Available to install"));
    await vi.waitFor(() => expect(text()).toContain("Gift box"));
    await click(registryRowButton("Gift box"));
    await vi.waitFor(() => expect(dialog()?.textContent).toContain("Install Gift box"));

    expect(dialog().querySelector("code")?.textContent).toBe("pnpm plugin add acme.wrap --registry https://registry.example/index.json");
    expect(dialog().textContent).toContain("Then deploy your store to finish.");
    expect(hasButton("Install")).toBe(false);
    await click(button("Copy command", dialog()));
    expect(writeText).toHaveBeenCalledWith("pnpm plugin add acme.wrap --registry https://registry.example/index.json");
  });

  it("lists registry updates for installed apps in Updates available", async () => {
    sdk.getApiV1AdminApps.mockImplementation(() => ok(LIST()));
    sdk.getApiV1AdminAppsRegistry.mockImplementation(() => ok(registryList({
      apps: [registryApp({ id: "acme.loyalty", name: "Loyalty points", version: "1.3.0", installed: { version: "1.2.0", source: "registry" }, updateAvailable: true })],
    })));
    await render(<AppsList />, VIEWER);
    await vi.waitFor(() => expect(text()).toContain("Loyalty points"));
    await click(tab("Updates available"));
    await vi.waitFor(() => expect(text()).toContain("Version 1.3.0 available"));
    expect(document.querySelector('a[href="/admin/apps/acme.loyalty"]')?.textContent).toContain("Version 1.3.0 available");
  });
});

describe("Upload, emergency stop and notices on the Apps list", () => {
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
      .mockImplementationOnce(() => refused(422, { code: "signature.untrusted", keyId: "key_new", developer: "Newcomer Ltd" }))
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
    sdk.postApiV1AdminAppsUpload.mockImplementation(() => refused(422, { code: "signature.untrusted", keyId: "key_new", developer: "Newcomer Ltd" }));
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
      .mockImplementationOnce(() => refused(422, { code: "signature.missing" }))
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

  it("lists stopped apps in a notice with their reasons and links to each", async () => {
    sdk.getApiV1AdminApps.mockImplementation(() => ok(LIST({
      apps: [
        thirdParty({ status: "disabled", failureReason: "Stopped automatically: it went over its limits 3 times within an hour." }),
        thirdParty({ id: "acme.sms", name: "SMS alerts", status: "disabled", failureReason: "Stopped with the emergency switch." }),
        summary({ id: "acme.feed", name: "Product feed", status: "disabled" }),
      ],
    })));
    await render(<AppsList />, VIEWER);
    await vi.waitFor(() => expect(text()).toContain("2 apps are stopped"));

    const notice = document.querySelector<HTMLElement>('[role="alert"]')!;
    expect(notice.textContent).toContain("Stopped automatically: it went over its limits 3 times within an hour.");
    expect(notice.textContent).toContain("Stopped with the emergency switch.");
    expect(notice.textContent).not.toContain("Product feed");
    expect(notice.querySelector('a[href="/admin/apps/acme.sms"]')).not.toBeNull();
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
    await renderApp(detail({ status: "active", source: "registry" }), MANAGER);
    await vi.waitFor(() => expect(hasButton("Stop now")).toBe(true));
    await click(button("Stop now"));
    await vi.waitFor(() => expect(dialog()?.textContent).toContain("Stop Loyalty points now?"));
    expect(dialog().textContent).toContain("Stops the app at once without running its code. Its data and settings stay. A Super Admin starts it again.");
    expect(sdk.postApiV1AdminAppsByIdStop).not.toHaveBeenCalled();

    await click(button("Stop now", dialog()));
    await vi.waitFor(() => expect(sdk.postApiV1AdminAppsByIdStop).toHaveBeenCalledWith({ path: { id: "acme.loyalty" } }));
    await vi.waitFor(() => expect(toasts.success).toHaveBeenCalledWith("App stopped"));
  });

  it("offers Stop now only to managers and only while the app is active", async () => {
    await renderApp(detail({ status: "active" }), VIEWER);
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
