// @vitest-environment happy-dom
// Settings → Notifications → browser notifications for buyers: the "Browser"
// column of the customer rules (disabled with the reason while not ready) and
// the "Browser notifications" card, whose "Send with" choice saves with the
// rules, under their revision, as the built-in sender ("") or an app's id.

import { act, type AnchorHTMLAttributes, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  getApiV1AdminSettingsNotificationChannels: vi.fn(),
  putApiV1AdminSettingsNotificationChannels: vi.fn(),
  getApiV1AdminSettingsProviders: vi.fn(),
  postApiV1AdminSettingsProvidersByIdTest: vi.fn(),
  getApiV1AdminAppsById: vi.fn(),
  putApiV1AdminAppsByIdSettings: vi.fn(),
}));
vi.mock("@scalius/api-client/sdk", () => sdk);
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useLocation: (options?: { select?: (location: { hash: string }) => unknown }) => (options?.select ? options.select({ hash: "" }) : { hash: "" }),
  Link: ({ to, params: _params, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string; params?: unknown; children: ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

import { PermissionProvider } from "~/contexts/PermissionContext";
import { setLocale } from "~/i18n";
import { SaveScope, type SaveScopeState } from "../shared/SaveBar";
import { BrowserNotificationsCard } from "./BrowserNotificationsCard";
import { CustomerNotificationsCard } from "./NotificationSettings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ok = (data: unknown) => Promise.resolve({ data: { success: true, data }, response: { status: 200 } });
const ready = { status: "ready", issues: [] };
const unready = { status: "incomplete", issues: [{ code: "web_push_unavailable", message: "Browser notifications need your store's https web address." }] };

function rules(overrides: Record<string, unknown> = {}) {
  return {
    channels: { order_created: ["email", "push"], order_shipped: ["sms"] },
    adminChannels: {},
    staffEmailRecipients: [],
    whatsappTemplate: { templateName: "order_status_update", languageCode: "en_US" },
    email: ready,
    sms: unready,
    whatsapp: unready,
    push: ready,
    customerPush: ready,
    pushProvider: "",
    revision: 5,
    ...overrides,
  };
}

function pushApp(configured: boolean) {
  return {
    id: "acme.push:acme",
    kind: "push",
    pluginId: "acme.push",
    appName: "Acme push",
    appIcon: null,
    icon: null,
    name: "Acme push service",
    operations: ["send"],
    canTestConnection: false,
    readiness: { configured, enabled: true, usable: configured, missingFields: configured ? [] : ["key"], credentialErrors: [] },
    environment: "unknown",
  };
}

let host: HTMLDivElement;
let root: Root;
let scope: SaveScopeState | null;

async function flush() {
  await act(async () => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
}

async function render(children: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  await act(async () => root.render(
    <QueryClientProvider client={queryClient}>
      <PermissionProvider isSuperAdmin>
        <SaveScope render={(next) => { scope = next; return null; }}>{children}</SaveScope>
      </PermissionProvider>
    </QueryClientProvider>,
  ));
  await flush();
}

beforeEach(() => {
  vi.clearAllMocks();
  setLocale("en");
  scope = null;
  notifyManager.setNotifyFunction((callback) => { act(callback); });
  document.body.innerHTML = "";
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  sdk.getApiV1AdminSettingsNotificationChannels.mockImplementation(() => ok(rules()));
  sdk.putApiV1AdminSettingsNotificationChannels.mockImplementation(({ body }: { body: Record<string, unknown> }) =>
    ok(rules({ pushProvider: body.pushProvider, revision: 6 })));
  sdk.getApiV1AdminSettingsProviders.mockImplementation(({ query }: { query: { kind: string } }) =>
    ok({ providers: query.kind === "push" ? [pushApp(true)] : [] }));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  notifyManager.setNotifyFunction((callback) => callback());
});

const browserBoxes = () => [...host.querySelectorAll<HTMLButtonElement>('button[role="checkbox"][aria-label$=": Browser"]')];

describe("the Browser column of the customer rules", () => {
  it("is a channel like the others, on where the rule was saved on", async () => {
    await render(<CustomerNotificationsCard />);
    await vi.waitFor(() => expect(browserBoxes().length).toBeGreaterThan(0));
    expect([...host.querySelectorAll("thead th")].map((cell) => cell.textContent)).toEqual(["Event", "Email", "SMS", "WhatsApp", "Browser"]);
    const created = browserBoxes().find((box) => box.getAttribute("aria-label")?.startsWith("Order placed"))!;
    expect(created.getAttribute("aria-checked")).toBe("true");
    expect(created.disabled).toBe(false);
    // A code or a key never goes to a browser: no checkbox on those rows.
    expect(host.querySelector('button[role="checkbox"][aria-label="Gift card received: Browser"]')).toBeNull();
  });

  it("is disabled with the reason when browser notifications are not ready, but a saved rule can still be switched off", async () => {
    sdk.getApiV1AdminSettingsNotificationChannels.mockImplementation(() => ok(rules({ customerPush: unready })));
    await render(<CustomerNotificationsCard />);
    await vi.waitFor(() => expect(browserBoxes().length).toBeGreaterThan(0));
    const shipped = browserBoxes().find((box) => box.getAttribute("aria-label")?.startsWith("Order shipped"))!;
    const created = browserBoxes().find((box) => box.getAttribute("aria-label")?.startsWith("Order placed"))!;
    expect(shipped.disabled).toBe(true);
    expect(created.disabled).toBe(false);
    expect(host.textContent).toContain("Browser notifications need your store's https web address.");
  });
});

describe("Browser notifications card", () => {
  it("offers the built-in sender and each app's push provider", async () => {
    await render(<BrowserNotificationsCard />);
    await vi.waitFor(() => expect(host.querySelector("#push-provider")).not.toBeNull());
    expect(host.textContent).toContain("Browser (built in)");
    await act(async () => host.querySelector<HTMLButtonElement>("#push-provider")!.click());
    await flush();
    const options = [...document.querySelectorAll<HTMLElement>('[role="option"]')];
    expect(options.map((option) => option.textContent)).toEqual([
      expect.stringContaining("Browser (built in)"),
      expect.stringContaining("Acme push service"),
    ]);
    expect(options[1]!.textContent).toContain("by Acme push");
  });

  it("saves an app's id with the rules as they are, under the revision it loaded", async () => {
    await render(<BrowserNotificationsCard />);
    await vi.waitFor(() => expect(host.querySelector("#push-provider")).not.toBeNull());
    await act(async () => host.querySelector<HTMLButtonElement>("#push-provider")!.click());
    await flush();
    await act(async () => [...document.querySelectorAll<HTMLElement>('[role="option"]')][1]!.click());
    await flush();
    // The chosen app shows its readiness and its setup button.
    expect(host.textContent).toContain("Acme push service");
    expect(host.textContent).toContain("Ready");
    let saved = false;
    await act(async () => { saved = await scope!.saveAll(); });
    expect(saved).toBe(true);
    expect(sdk.putApiV1AdminSettingsNotificationChannels).toHaveBeenCalledTimes(1);
    const body = sdk.putApiV1AdminSettingsNotificationChannels.mock.calls[0]![0].body;
    expect(body).toMatchObject({ pushProvider: "acme.push:acme", expectedRevision: 5 });
    expect(body.channels.order_created).toEqual(["email", "push"]);
    expect(body.channels.order_shipped).toEqual(["sms"]);
  });

  it("saves the built-in sender as an empty id when the merchant goes back to it", async () => {
    sdk.getApiV1AdminSettingsNotificationChannels.mockImplementation(() => ok(rules({ pushProvider: "acme.push:acme" })));
    await render(<BrowserNotificationsCard />);
    await vi.waitFor(() => expect(host.querySelector("#push-provider")).not.toBeNull());
    await act(async () => host.querySelector<HTMLButtonElement>("#push-provider")!.click());
    await flush();
    await act(async () => [...document.querySelectorAll<HTMLElement>('[role="option"]')][0]!.click());
    await flush();
    let saved = false;
    await act(async () => { saved = await scope!.saveAll(); });
    expect(saved).toBe(true);
    expect(sdk.putApiV1AdminSettingsNotificationChannels.mock.calls[0]![0].body).toMatchObject({ pushProvider: "", expectedRevision: 5 });
  });

  it("says why the built-in sender is not ready, and that an app can send instead", async () => {
    sdk.getApiV1AdminSettingsNotificationChannels.mockImplementation(() => ok(rules({ customerPush: unready })));
    sdk.getApiV1AdminSettingsProviders.mockImplementation(() => ok({ providers: [] }));
    await render(<BrowserNotificationsCard />);
    await vi.waitFor(() => expect(host.textContent).toContain("Browser notifications need your store's https web address."));
    expect(host.textContent).toContain("An app can send them instead.");
    expect(host.querySelector('a[href="/admin/apps"]')).not.toBeNull();
  });

  it("writes the not-ready reason in Bangla in the Bangla dashboard, not the API's English", async () => {
    setLocale("bn");
    sdk.getApiV1AdminSettingsNotificationChannels.mockImplementation(() => ok(rules({ customerPush: unready })));
    sdk.getApiV1AdminSettingsProviders.mockImplementation(() => ok({ providers: [] }));
    await render(<BrowserNotificationsCard />);
    await vi.waitFor(() => expect(host.textContent).toContain("ওয়েব ঠিকানা লাগে"));
    expect(host.textContent).not.toContain("need your store");
  });
});
