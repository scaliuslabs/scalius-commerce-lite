// @vitest-environment happy-dom

import { act, type AnchorHTMLAttributes, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginUiDocument, PluginUiNode } from "@scalius/shared/plugins/ui";

const sdk = vi.hoisted(() => ({ getApiV1AdminAppsSurfaces: vi.fn() }));
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }));
const navigate = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("@scalius/api-client/sdk", () => sdk);
vi.mock("sonner", () => ({ toast: toasts }));
vi.mock("~/hooks/use-currency", () => ({
  useCurrency: () => ({ code: "BDT", symbol: "৳", fmt: (amount: number) => `৳${amount.toFixed(2)}` }),
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
  Link: ({ to, search, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string; search?: Record<string, string>; children: ReactNode }) => (
    <a href={search ? `${to}?${new URLSearchParams(search).toString()}` : to} {...props}>{children}</a>
  ),
}));

import { PermissionProvider } from "~/contexts/PermissionContext";
import { setLocale } from "~/i18n";
import { AppActionsMenu, AppBulkActionsMenu } from "./AppActions";
import { AppHomeWidgets, AppResourceCards } from "./AppResourceCards";
import { PluginSurface } from "./PluginSurface";
import { PluginUiRenderer, type PluginUiHost } from "./PluginUiRenderer";
import type { AppSurfaces } from "./surfaces";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// Cards load as soon as they mount when the browser can't tell visibility.
vi.stubGlobal("IntersectionObserver", undefined);

const USER = ["apps.view", "apps.use"];
const VIEWER = ["apps.view"];

const app: AppSurfaces = {
  id: "acme.app",
  name: "Acme",
  pages: [{ id: "overview", title: "Overview", placement: "apps", route: "dashboard", tabs: null }],
  cards: [
    { id: "summary", target: "order", title: "Acme summary", route: "order-card" },
    { id: "risk", target: "order", title: "Acme risk", route: "risk-card" },
  ],
  actions: [
    { id: "wave", target: "product", label: "Wave hello", route: "wave", bulk: true, destructive: false },
    { id: "purge", target: "customer", label: "Forget customer", route: "purge", bulk: false, destructive: true },
  ],
  widgets: [{ id: "counts", title: "Acme counts", route: "widget" }],
  listColumns: [],
  routes: [
    { name: "dashboard", methods: ["GET"] },
    { name: "order-card", methods: ["GET"] },
    { name: "risk-card", methods: ["GET"] },
    { name: "widget", methods: ["GET"] },
    { name: "save", methods: ["POST"] },
    { name: "wave", methods: ["POST"] },
    { name: "purge", methods: ["POST"] },
  ],
  providers: [],
};

// ── Network ───────────────────────────────────────────────────────────────

type Handler = (url: URL, init: RequestInit) => { status?: number; body: unknown } | Promise<{ status?: number; body: unknown }>;
const routes = new Map<string, Handler>();
const fetchMock = vi.fn(async (input: string, init: RequestInit = {}) => {
  const url = new URL(input, "https://admin.test");
  const key = `${init.method ?? "GET"} ${url.pathname}`;
  const handler = routes.get(key);
  if (!handler) return new Response(JSON.stringify({ success: false, error: { code: "NOT_FOUND", message: "Not found." } }), { status: 404 });
  const { status = 200, body } = await handler(url, init);
  return new Response(JSON.stringify(body), { status });
});
vi.stubGlobal("fetch", fetchMock);

const route = (method: string, name: string, handler: Handler) => routes.set(`${method} /api/v1/plugins/acme.app/admin/${name}`, handler);
const calls = (method: string, name: string) =>
  fetchMock.mock.calls.filter(([input, init]) => (init?.method ?? "GET") === method && new URL(input, "https://admin.test").pathname === `/api/v1/plugins/acme.app/admin/${name}`);
const sentBody = (method: string, name: string) => JSON.parse(String(calls(method, name).at(-1)![1]!.body)) as Record<string, unknown>;
const doc = (root: PluginUiNode): PluginUiDocument => ({ version: 1, root });
const surfaces = (apps: AppSurfaces[]) => Promise.resolve({ data: { success: true, data: { apps } }, response: { status: 200 } });

// ── Rendering ─────────────────────────────────────────────────────────────

let host: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;

async function flush() {
  await act(async () => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  });
}

async function render(node: ReactNode, permissions: string[] = USER) {
  await act(async () =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <PermissionProvider permissions={permissions}>{node}</PermissionProvider>
      </QueryClientProvider>,
    ));
  await flush();
}

function hostFor(overrides: Partial<PluginUiHost> = {}): PluginUiHost {
  return { app, refresh: vi.fn(), replace: vi.fn(), paginate: { go: vi.fn(), back: null }, ...overrides };
}

const renderTree = (tree: PluginUiNode, options: { host?: PluginUiHost; permissions?: string[]; variant?: "page" | "embedded" } = {}) =>
  render(<PluginUiRenderer document={doc(tree)} host={options.host ?? hostFor()} variant={options.variant ?? "page"} fallbackTitle="Overview" />, options.permissions);

const text = () => document.body.textContent ?? "";

function button(label: string, within: ParentNode = document): HTMLButtonElement {
  const match = [...within.querySelectorAll("button")].find((element) => element.textContent?.trim() === label || element.getAttribute("aria-label") === label);
  if (!match) throw new Error(`No button "${label}"`);
  return match;
}

/** The control a label names (inputs are labelled, so this is how staff reach them). */
function field(label: string): HTMLElement {
  const element = [...document.querySelectorAll("label")].find((candidate) => candidate.textContent?.startsWith(label));
  const control = element ? document.getElementById(element.htmlFor) : null;
  if (!control) throw new Error(`No field "${label}"`);
  return control;
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
  await flush();
}

async function type(input: HTMLElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function openMenu(label: string) {
  // The menu appears once the apps' surfaces have loaded.
  const trigger = await vi.waitFor(() => button(label));
  await act(async () => {
    trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
  });
  await flush();
}

const menuItem = (label: string) => {
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((element) => element.textContent?.includes(label));
  if (!item) throw new Error(`No menu item "${label}"`);
  return item;
};

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  sdk.getApiV1AdminAppsSurfaces.mockImplementation(() => surfaces([app]));
});

afterEach(() => {
  setLocale("en");
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  routes.clear();
  vi.clearAllMocks();
});

// ── The renderer ──────────────────────────────────────────────────────────

describe("app UI renderer", () => {
  it("draws every content node with dashboard components, as plain text", async () => {
    await renderTree({
      type: "page",
      title: "Loyalty <b>points</b>",
      description: "What the app did.",
      children: [
        { type: "section", title: "Numbers", children: [{ type: "columns", children: [{ type: "stat", label: "Members", value: 1200, help: "This month" }, { type: "stat", label: "Tier", value: "Gold" }] }] },
        {
          type: "card",
          title: "Details",
          children: [
            { type: "heading", text: "Heading three", level: 3 },
            { type: "text", text: "<b>bold</b> & <script>alert(1)</script>", tone: "critical", emphasis: "mono" },
            { type: "badge", text: "Synced", tone: "success" },
            { type: "key-value", items: [{ label: "Plan", value: "Pro" }, { label: "Active", value: true }, { label: "Points", value: 2500 }, { label: "Expires", value: null }] },
            { type: "divider" },
            { type: "card", title: "Nested", children: [{ type: "text", text: "Inside" }] },
            { type: "image", src: "https://cdn.acme.example/a.png", alt: "Logo", width: 40, height: 40 },
          ],
        },
        { type: "banner", tone: "warning", title: "Heads up", text: "Sync is slow." },
        { type: "empty-state", title: "No rewards yet", text: "They show here." },
        { type: "stack", direction: "horizontal", gap: "sm", children: [{ type: "badge", text: "A" }, { type: "badge", text: "B" }] },
      ],
    });

    // App text is never HTML: tags show literally and no element is created.
    expect(document.querySelector("h1")?.textContent).toBe("Loyalty <b>points</b>");
    expect(text()).toContain("<b>bold</b> & <script>alert(1)</script>");
    expect(document.querySelector("b")).toBeNull();
    expect(document.querySelector("script")).toBeNull();
    expect(text()).toContain("What the app did.");
    expect(text()).toContain("1,200");
    expect(text()).toContain("This month");
    expect(document.querySelector("h3")?.textContent).toBe("Heading three");
    expect(text()).toContain("Synced");
    expect([...document.querySelectorAll("dd")].map((dd) => dd.textContent)).toEqual(["Pro", "Yes", "2,500", "—"]);
    expect(document.querySelector('[data-slot="separator-root"]')).not.toBeNull();
    expect(document.querySelector("img")?.getAttribute("src")).toBe("https://cdn.acme.example/a.png");
    expect(document.querySelector("img")?.getAttribute("alt")).toBe("Logo");
    expect(document.querySelector('[data-slot="alert"]')?.textContent).toContain("Sync is slow.");
    expect(text()).toContain("No rewards yet");
    // A card inside a card is drawn as a section of it.
    const nested = [...document.querySelectorAll("section")].find((section) => section.textContent?.includes("Inside"));
    expect(nested?.querySelector("h3")?.textContent).toBe("Nested");
  });

  it("links only to this app's pages, Scalius resource pages and https sites in a new tab", async () => {
    await renderTree({
      type: "stack",
      children: [
        { type: "link", text: "Product", to: { kind: "resource", resource: "product", id: "p1" } },
        { type: "link", text: "Order", to: { kind: "resource", resource: "order", id: "o1" } },
        { type: "link", text: "Customer", to: { kind: "resource", resource: "customer", id: "c1" } },
        { type: "link", text: "Category", to: { kind: "resource", resource: "category", id: "cat1" } },
        { type: "link", text: "Collection", to: { kind: "resource", resource: "collection", id: "col1" } },
        { type: "link", text: "Brand", to: { kind: "resource", resource: "brand", id: "b1" } },
        { type: "link", text: "CMS page", to: { kind: "resource", resource: "page", id: "pg1" } },
        { type: "link", text: "App page", to: { kind: "app-page", page: "overview", query: { tab: "tiers" } } },
        { type: "link", text: "Docs", to: { kind: "external", href: "https://docs.acme.example/help" } },
      ],
    });
    const href = (label: string) => [...document.querySelectorAll("a")].find((anchor) => anchor.textContent?.startsWith(label))!;
    expect(href("Product").getAttribute("href")).toBe("/admin/products/p1/edit");
    expect(href("Order").getAttribute("href")).toBe("/admin/orders/o1");
    expect(href("Customer").getAttribute("href")).toBe("/admin/customers/c1/edit");
    expect(href("Category").getAttribute("href")).toBe("/admin/categories/cat1/edit");
    expect(href("Collection").getAttribute("href")).toBe("/admin/collections/col1/edit");
    expect(href("Brand").getAttribute("href")).toBe("/admin/brands/b1/edit");
    expect(href("CMS page").getAttribute("href")).toBe("/admin/pages/pg1/edit");
    expect(href("App page").getAttribute("href")).toBe("/admin/apps/acme.app/pages/overview?tab=tiers");
    const docs = href("Docs");
    expect(docs.getAttribute("href")).toBe("https://docs.acme.example/help");
    expect(docs.getAttribute("target")).toBe("_blank");
    expect(docs.getAttribute("rel")).toBe("noopener noreferrer");
    expect(docs.textContent).toContain("(opens in a new tab)");
  });

  it("draws tables with money, dates, badges and row links, and pages through the surface", async () => {
    const paginate = { go: vi.fn(), back: vi.fn() };
    await renderTree({
      type: "table",
      caption: "Recent greetings",
      columns: [{ key: "order", label: "Order" }, { key: "total", label: "Total", align: "end" }, { key: "state", label: "State" }, { key: "at", label: "When" }, { key: "paid", label: "Paid" }],
      rows: [{
        id: "r1",
        to: { kind: "resource", resource: "order", id: "o1" },
        cells: { order: "#1001", total: { money: 125050 }, state: { badge: "Greeted", tone: "success" }, at: { date: "2026-10-02" }, paid: false },
      }],
      pagination: { next: "cursor-2", total: 31 },
    }, { host: hostFor({ paginate }) });

    expect(document.querySelector("caption")?.textContent).toBe("Recent greetings");
    expect(document.querySelector('a[href="/admin/orders/o1"]')?.textContent).toBe("#1001");
    expect(text()).toContain("৳1250.50");
    expect(text()).toContain("Greeted");
    expect(document.querySelector("time")?.getAttribute("dateTime")).toBe("2026-10-02");
    expect(text()).toContain("No");
    expect(text()).toContain("31 results");
    await click(button("Next page"));
    expect(paginate.go).toHaveBeenCalledWith("cursor-2");
    // No previous cursor from the app: Back returns to the page before.
    await click(button("Previous page"));
    expect(paginate.back).toHaveBeenCalled();
  });

  it("shows a table's empty state", async () => {
    await renderTree({ type: "table", columns: [{ key: "a", label: "A" }], rows: [], empty: { title: "No greetings yet", text: "Paid orders are greeted here." } });
    expect(text()).toContain("No greetings yet");
    expect(document.querySelector("table")).toBeNull();
  });
});

// ── Forms and buttons ─────────────────────────────────────────────────────

const signupForm: PluginUiNode = {
  type: "form",
  action: { route: "save", body: { step: "signup" } },
  submitLabel: "Save member",
  children: [
    { type: "text-field", name: "name", label: "Name", required: true, minLength: 3 },
    { type: "text-field", name: "email", label: "Email", format: "email" },
    { type: "number-field", name: "points", label: "Points", min: 1, integer: true },
    { type: "date-field", name: "joined", label: "Joined", min: "2026-02-01" },
    { type: "checkbox", name: "vip", label: "VIP", value: true },
    { type: "select", name: "tier", label: "Tier", value: "gold", options: [{ value: "gold", label: "Gold" }, { value: "silver", label: "Silver" }] },
  ],
};

describe("app forms", () => {
  it("checks values before sending and says what to fix", async () => {
    await renderTree(signupForm);
    await click(button("Save member"));
    expect(field("Name").getAttribute("aria-invalid")).toBe("true");
    expect(text()).toContain("Fill this in.");
    expect(text()).toContain("Check the marked fields.");

    await type(field("Name"), "Al");
    await type(field("Email"), "nope");
    await type(field("Points"), "2.5");
    expect(text()).toContain("Use at least 3 characters.");
    expect(text()).toContain("Enter an email address.");
    expect(text()).toContain("Enter a whole number.");
    await click(button("Save member"));
    expect(calls("POST", "save")).toHaveLength(0);
  });

  it("draws a date field as a calendar that offers no day before its earliest", async () => {
    await renderTree(signupForm);
    // Shown with the month as a word, empty until picked.
    expect(field("Joined").textContent).toContain("Pick a date");
    await click(field("Joined"));
    // The calendar's code arrives when the field is opened.
    for (let attempt = 0; attempt < 60 && !document.querySelector("[data-day]"); attempt += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    }
    const earlier = document.querySelector<HTMLButtonElement>('button[data-day="2026-01-15"]');
    const later = document.querySelector<HTMLButtonElement>('button[data-day="2026-02-15"]');
    expect(earlier === null || earlier.disabled).toBe(true);
    expect(later?.disabled).toBe(false);
  });

  it("sends the values with the action's body and maps the app's errors onto the inputs", async () => {
    route("POST", "save", () => ({ status: 422, body: { errors: { email: "Already a member.", other: "Try later." } } }));
    await renderTree(signupForm);
    await type(field("Name"), "Rahim");
    await type(field("Email"), "rahim@example.com");
    await type(field("Points"), "40");
    await click(button("Save member"));

    expect(sentBody("POST", "save")).toEqual({
      step: "signup",
      values: { name: "Rahim", email: "rahim@example.com", points: 40, joined: null, vip: true, tier: "gold" },
    });
    expect(field("Email").getAttribute("aria-invalid")).toBe("true");
    expect(text()).toContain("Already a member.");
    // A message for no input of this form shows under the form.
    expect(text()).toContain("Try later.");
    // Editing the field clears the app's message.
    await type(field("Email"), "rahim2@example.com");
    expect(text()).not.toContain("Already a member.");
  });

  it("shows the app's own error on an input it sent with the tree", async () => {
    await renderTree({ type: "form", action: { route: "save" }, submitLabel: "Save", children: [{ type: "text-field", name: "code", label: "Code", error: "That code expired." }] });
    expect(field("Code").getAttribute("aria-invalid")).toBe("true");
    expect(text()).toContain("That code expired.");
  });

  it("asks before a confirmed action and sends nothing when cancelled", async () => {
    route("POST", "save", () => ({ body: { toast: { message: "Counters reset." }, refresh: true } }));
    const surfaceHost = hostFor();
    await renderTree({
      type: "button",
      label: "Reset counters",
      tone: "critical",
      action: { route: "save" },
      confirm: { title: "Reset the counters?", text: "Counts start again at zero.", confirmLabel: "Reset", destructive: true },
    }, { host: surfaceHost });

    await click(button("Reset counters"));
    const dialog = document.querySelector<HTMLElement>('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain("Reset the counters?");
    expect(dialog.textContent).toContain("Counts start again at zero.");
    await click(button("Cancel", dialog));
    expect(calls("POST", "save")).toHaveLength(0);

    await click(button("Reset counters"));
    await click(button("Reset", document.querySelector<HTMLElement>('[role="alertdialog"]')!));
    await vi.waitFor(() => expect(toasts.success).toHaveBeenCalledWith("Counters reset."));
    expect(calls("POST", "save")).toHaveLength(1);
    expect(surfaceHost.refresh).toHaveBeenCalled();
  });

  it("opens the page an action names", async () => {
    route("POST", "save", () => ({ body: { navigate: { kind: "resource", resource: "order", id: "o9" } } }));
    await renderTree({ type: "button", label: "Open order", action: { route: "save" } });
    await click(button("Open order"));
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/admin/orders/o9" }));
  });

  it("refuses a button whose route the app never declared, without calling it", async () => {
    await renderTree({ type: "button", label: "Sneaky", action: { route: "undeclared" } });
    await click(button("Sneaky"));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')?.textContent).toBe("This button isn't set up correctly, so nothing was sent.");
  });

  it("refuses a declared route with an undeclared method", async () => {
    await renderTree({ type: "button", label: "Delete it", action: { route: "save", method: "DELETE" } });
    await click(button("Delete it"));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("disables actions for staff who may only view apps, and says why", async () => {
    await renderTree({ type: "stack", children: [{ type: "button", label: "Run", action: { route: "save" } }, { type: "link", text: "Help", to: { kind: "external", href: "https://acme.example" } }] }, { permissions: VIEWER });
    expect(button("Run").disabled).toBe(true);
    expect(text()).toContain("Ask the store owner for access to use this app's actions.");
  });
});

// ── Surfaces ──────────────────────────────────────────────────────────────

describe("app surfaces", () => {
  it("replaces the tree with an action's `ui` answer and refreshes on request", async () => {
    let served = 0;
    route("GET", "dashboard", () => {
      served += 1;
      return { body: doc({ type: "page", title: "Hello", children: [{ type: "text", text: `Served ${served}` }, { type: "button", label: "Swap", action: { route: "save" } }] }) };
    });
    route("POST", "save", () => ({ body: { ui: doc({ type: "page", children: [{ type: "text", text: "Replaced tree" }, { type: "button", label: "Again", action: { route: "save", body: { again: true } } }] }) } }));
    await render(<PluginSurface app={app} route="dashboard" query={{}} variant="page" title="Overview" />);
    await vi.waitFor(() => expect(text()).toContain("Served 1"));
    expect(document.querySelector("h1")?.textContent).toBe("Hello");

    await click(button("Swap"));
    await vi.waitFor(() => expect(text()).toContain("Replaced tree"));
    // The page header falls back to the manifest title.
    expect(document.querySelector("h1")?.textContent).toBe("Overview");

    route("POST", "save", () => ({ body: { refresh: true } }));
    await click(button("Again"));
    await vi.waitFor(() => expect(text()).toContain("Served 2"));
    expect(calls("GET", "dashboard")).toHaveLength(2);
  });

  it("draws one tab of a tabbed app page without a header of its own, its description and actions first", async () => {
    route("GET", "dashboard", () => ({
      body: doc({ type: "page", title: "Tab title", description: "What this tab shows.", actions: [{ type: "button", label: "Reset", action: { route: "save" } }], children: [{ type: "text", text: "Tab body" }] }),
    }));
    await render(<PluginSurface app={app} route="dashboard" query={{}} variant="tab" title="Summary" />);
    await vi.waitFor(() => expect(text()).toContain("Tab body"));
    // The page around it draws the title and tabs; the tab draws no h1.
    expect(document.querySelector("h1")).toBeNull();
    expect(text()).toContain("What this tab shows.");
    expect(button("Reset")).toBeTruthy();
  });

  it("re-requests the surface with a table's cursor", async () => {
    route("GET", "dashboard", (url) => ({
      body: doc({
        type: "table",
        columns: [{ key: "n", label: "N" }],
        rows: [{ cells: { n: url.searchParams.get("cursor") ? "Second page" : "First page" } }],
        pagination: { next: url.searchParams.get("cursor") ? null : "c2" },
      }),
    }));
    await render(<PluginSurface app={app} route="dashboard" query={{ tab: "all" }} variant="embedded" />);
    await vi.waitFor(() => expect(text()).toContain("First page"));
    await click(button("Next page"));
    await vi.waitFor(() => expect(text()).toContain("Second page"));
    const second = new URL(calls("GET", "dashboard").at(-1)![0], "https://admin.test");
    expect(Object.fromEntries(second.searchParams)).toEqual({ tab: "all", cursor: "c2" });
    await click(button("Previous page"));
    await vi.waitFor(() => expect(text()).toContain("First page"));
  });

  it("asks for a newer dashboard when the app speaks a newer UI version", async () => {
    route("GET", "dashboard", () => ({ body: { version: 2, root: { type: "hologram" } } }));
    await render(<PluginSurface app={app} route="dashboard" query={{}} variant="embedded" />);
    await vi.waitFor(() => expect(text()).toContain("This app needs a newer dashboard"));
  });

  it("explains an invalid tree, with the issue path for developers", async () => {
    route("GET", "dashboard", () => ({ body: { version: 1, root: { type: "page", children: [{ type: "text-field", name: "loose", label: "Loose" }] } } }));
    await render(<PluginSurface app={app} route="dashboard" query={{}} variant="embedded" />);
    await vi.waitFor(() => expect(text()).toContain("This app sent something the dashboard can't show"));
    expect(document.querySelector("details")?.textContent).toContain("root.children.0");
    expect(document.querySelector("details")?.textContent).toContain("Inputs belong inside a form.");
  });

  it("shows the app's masked reason when it fails, and tries again", async () => {
    route("GET", "dashboard", () => ({ status: 502, body: { success: false, error: { code: "APP_FAILED", message: "Points service is down" } } }));
    await render(<PluginSurface app={app} route="dashboard" query={{}} variant="embedded" />);
    await vi.waitFor(() => expect(text()).toContain("Points service is down"));
    route("GET", "dashboard", () => ({ body: doc({ type: "text", text: "Back up" }) }));
    await click(button("Try again"));
    await vi.waitFor(() => expect(text()).toContain("Back up"));
  });
});

// ── Resource cards and widgets ────────────────────────────────────────────

describe("app resource cards", () => {
  it("draws each app card with one request, keeping a failing card to itself", async () => {
    route("GET", "order-card", (url) => ({ body: doc({ type: "stack", children: [{ type: "text", text: `Summary for ${url.searchParams.get("id")}` }, { type: "button", label: "Greet", action: { route: "save", body: { kind: "greet" } } }] }) }));
    route("GET", "risk-card", () => ({ status: 504, body: { success: false, error: { code: "APP_TIMEOUT", message: "The app took too long to answer." } } }));
    route("POST", "save", () => ({ body: { toast: { message: "Greeted." } } }));
    await render(
      <div>
        <p>Order page content</p>
        <AppResourceCards target="order" id="o1" />
      </div>,
    );

    await vi.waitFor(() => expect(text()).toContain("Summary for o1"));
    await vi.waitFor(() => expect(text()).toContain("The app took too long to answer."));
    expect(text()).toContain("Order page content");
    expect(text()).toContain("Acme summary");
    expect(text()).toContain("From Acme");
    expect(calls("GET", "order-card")).toHaveLength(1);
    expect(calls("GET", "risk-card")).toHaveLength(1);
    const query = Object.fromEntries(new URL(calls("GET", "order-card")[0]![0], "https://admin.test").searchParams);
    expect(query).toEqual({ resource: "order", id: "o1", surface: "summary" });

    // A card's button says which record it's about; the app's body is kept.
    await click(button("Greet"));
    await vi.waitFor(() => expect(toasts.success).toHaveBeenCalledWith("Greeted."));
    expect(sentBody("POST", "save")).toEqual({ kind: "greet", resource: "order", ids: ["o1"] });

    // Collapsing keeps the card's content (no second request).
    const toggle = button("Acme summaryFrom Acme");
    await click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await click(toggle);
    expect(calls("GET", "order-card")).toHaveLength(1);
  });

  it("shows nothing, and asks nothing, without apps.view", async () => {
    await render(<AppResourceCards target="order" id="o1" />, ["orders.view"]);
    expect(host.innerHTML).toBe("");
    expect(sdk.getApiV1AdminAppsSurfaces).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows nothing when no app has a card for the resource", async () => {
    await render(<AppResourceCards target="brand" id="b1" />);
    await vi.waitFor(() => expect(sdk.getApiV1AdminAppsSurfaces).toHaveBeenCalled());
    expect(host.innerHTML).toBe("");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("draws home widgets", async () => {
    route("GET", "widget", (url) => ({ body: doc({ type: "stat", label: "Greeted orders", value: url.searchParams.get("surface") === "counts" ? 7 : 0 }) }));
    await render(<AppHomeWidgets />);
    await vi.waitFor(() => expect(text()).toContain("Greeted orders"));
    expect(text()).toContain("Acme counts");
    expect(text()).toContain("7");
  });
});

// ── Manifest actions ──────────────────────────────────────────────────────

describe("app actions", () => {
  it("runs a bulk action on the selected rows with { resource, ids, action }", async () => {
    route("POST", "wave", () => ({ body: { toast: { message: "Hello to 2 products!" } } }));
    const done = vi.fn();
    await render(<AppBulkActionsMenu target="product" ids={["p1", "p2"]} onDone={done} />);
    await openMenu("Apps");
    await click(menuItem("Wave hello"));
    await vi.waitFor(() => expect(toasts.success).toHaveBeenCalledWith("Hello to 2 products!"));
    expect(sentBody("POST", "wave")).toEqual({ resource: "product", ids: ["p1", "p2"], action: "wave" });
    expect(done).toHaveBeenCalled();
  });

  it("refuses more than 250 records", async () => {
    await render(<AppBulkActionsMenu target="product" ids={Array.from({ length: 251 }, (_, index) => `p${index}`)} />);
    await openMenu("Apps");
    expect(menuItem("Wave hello").getAttribute("aria-disabled")).toBe("true");
    expect(menuItem("Wave hello").textContent).toContain("App actions run on up to 250 at a time.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("asks before a destructive detail-page action, naming it", async () => {
    route("POST", "purge", () => ({ status: 409, body: { toast: { message: "Customer has open orders.", tone: "critical" } } }));
    await render(<AppActionsMenu target="customer" id="c1" />);
    await openMenu("More actions");
    await click(menuItem("Forget customer"));
    // The confirm loads the first time an action asks.
    await vi.waitFor(() => expect(document.querySelector('[role="alertdialog"]')).not.toBeNull());
    const dialog = document.querySelector<HTMLElement>('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain("Forget customer?");
    expect(fetchMock).not.toHaveBeenCalled();
    await click(button("Forget customer", dialog));
    await vi.waitFor(() => expect(toasts.error).toHaveBeenCalledWith("Customer has open orders."));
    expect(sentBody("POST", "purge")).toEqual({ resource: "customer", ids: ["c1"], action: "purge" });
  });

  it("offers nothing without apps.use", async () => {
    await render(
      <>
        <AppActionsMenu target="customer" id="c1" />
        <AppBulkActionsMenu target="product" ids={["p1"]} />
      </>,
      VIEWER,
    );
    await vi.waitFor(() => expect(sdk.getApiV1AdminAppsSurfaces).toHaveBeenCalled());
    expect(document.querySelectorAll("button")).toHaveLength(0);
  });
});
