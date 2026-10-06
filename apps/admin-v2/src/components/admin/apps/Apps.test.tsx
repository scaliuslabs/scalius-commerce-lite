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
}));
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
const navigate = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("@scalius/api-client/sdk", () => sdk);
vi.mock("sonner", () => ({ toast: toasts }));
vi.mock("~/components/admin/shared/UnsavedChangesGuard", () => ({ UnsavedChangesGuard: () => null }));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
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
    },
    routes: { admin: [], public: [], webhooks: [] },
    cron: [],
    storage: [],
    customFields: [],
    storefront: { proxy: false, head: false, sections: 0, productBlocks: 0, scripts: [] },
    admin: { pages: [], cards: 0, actions: 0, widgets: 0 },
    limits: { cpuMs: 50, wallMs: 1000 },
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
