// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  getApiV1AdminSettingsCheckoutFlow: vi.fn(),
  getApiV1AdminSettingsPaymentMethods: vi.fn(),
  getApiV1AdminSettingsCurrency: vi.fn(),
  getApiV1AdminSettingsPlatform: vi.fn(),
  getApiV1AdminSettingsStripe: vi.fn(),
  getApiV1AdminSettingsSslcommerz: vi.fn(),
  getApiV1AdminSettingsProviders: vi.fn(),
  postApiV1AdminSettingsProvidersByIdTest: vi.fn(),
  postApiV1AdminSettingsStripe: vi.fn(),
  postApiV1AdminSettingsSslcommerz: vi.fn(),
  postApiV1AdminSettingsPaymentMethods: vi.fn(),
  deleteApiV1AdminSettingsStripe: vi.fn(),
  deleteApiV1AdminSettingsSslcommerz: vi.fn(),
}));
vi.mock("@scalius/api-client/sdk", () => sdk);
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, params, children, ...props }: { to: string; params?: Record<string, string>; children: ReactNode }) => (
    <a href={to.replace("$pluginId", params?.pluginId ?? "")} {...props}>{children}</a>
  ),
}));

import { PermissionProvider } from "~/contexts/PermissionContext";
import { SaveErrorBanner, SaveScope, type SaveScopeState } from "../shared/SaveBar";
import { PaymentMethodsCard } from "./PaymentsSettings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const envelope = <T,>(data: T) => Promise.resolve({ data: { success: true, data } });
const BKASH = "scalius.bangladesh:bkash";
const NAGAD = "scalius.bangladesh:nagad";

const ready = { configured: true, enabled: true, usable: true, missingFields: [], providerEnabled: true, environment: "live" };

function methods(enabledMethods: string[] = ["cod"]) {
  return {
    enabledMethods,
    defaultMethod: "cod",
    revision: 7,
    gateways: [
      { id: "stripe", label: "Stripe", checkoutName: "Card", flow: "card", pluginId: null, supportsRefund: true, chargeCurrencies: "any" },
      { id: BKASH, label: "bKash", checkoutName: "bKash", flow: "hosted", pluginId: "scalius.bkash", supportsRefund: true, chargeCurrencies: ["BDT"] },
    ],
    gatewayStatus: {
      cod: { ...ready, environment: "not_applicable", checkoutSelected: true },
      stripe: { configured: false, enabled: false, usable: false, missingFields: ["secretKey"], providerEnabled: false },
      [BKASH]: { ...ready, environment: "test" },
    },
  };
}

const providers = [
  {
    id: BKASH,
    kind: "payment",
    pluginId: "scalius.bkash",
    appName: "bKash Payments",
    appIcon: "/api/v1/admin/apps/scalius.bkash/assets/icon?v=63a5ccd16b4c0000",
    name: "bKash",
    operations: ["verifyReturn", "queryPayment", "testConnection"],
    canTestConnection: true,
    readiness: { configured: true, enabled: true, usable: true, missingFields: [], credentialErrors: [] },
    environment: "test",
  },
  {
    id: NAGAD,
    kind: "payment",
    pluginId: "scalius.nagad",
    appName: "Nagad",
    appIcon: null,
    name: "Nagad",
    operations: ["verifyReturn", "queryPayment", "testConnection"],
    canTestConnection: true,
    readiness: {
      configured: true,
      enabled: false,
      usable: false,
      missingFields: [],
      credentialErrors: [],
      blockedReason: "Activate Nagad in Apps to use it.",
    },
    environment: "unknown",
  },
];

const row = (id: string) => document.querySelector<HTMLElement>(`[data-method="${id}"]`)!;
const toggle = (id: string) => row(id).querySelector<HTMLButtonElement>("[role=switch]")!;

describe("app payment providers in payment settings", () => {
  let root: Root;
  let container: HTMLDivElement;
  let page: SaveScopeState | null;

  beforeEach(() => {
    vi.clearAllMocks();
    notifyManager.setNotifyFunction((callback) => { act(callback); });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    page = null;
    sdk.getApiV1AdminSettingsCheckoutFlow.mockImplementation(() =>
      envelope({ guestCheckoutEnabled: true, checkoutMode: "all", partialPaymentEnabled: false, partialPaymentAmount: 0, revision: 1 }));
    sdk.getApiV1AdminSettingsCurrency.mockImplementation(() => envelope({ currencyCode: "BDT", currencySymbol: "৳" }));
    sdk.getApiV1AdminSettingsPaymentMethods.mockImplementation(() => envelope(methods()));
    sdk.getApiV1AdminSettingsProviders.mockImplementation(() => envelope({ providers }));
    sdk.postApiV1AdminSettingsPaymentMethods.mockImplementation(() => envelope({ message: "ok", revision: 8 }));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = "";
    notifyManager.setNotifyFunction((callback) => callback());
  });

  async function renderCard() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <PermissionProvider isSuperAdmin>
            <SaveScope render={(state) => { page = state; return null; }}>
              <PaymentMethodsCard />
            </SaveScope>
          </PermissionProvider>
        </QueryClientProvider>,
      );
    });
    await vi.waitFor(() => expect(container.querySelector(`[data-method="${NAGAD}"]`)).not.toBeNull());
  }

  it("restores a re-enabled method's saved checkout position but keeps intentional reordering dirty", async () => {
    sdk.getApiV1AdminSettingsPaymentMethods.mockImplementation(() => envelope(methods([BKASH, "cod"])));
    await renderCard();
    expect(page?.dirty).toBe(false);
    await act(async () => toggle(BKASH).click());
    expect(page?.dirty).toBe(true);
    await act(async () => toggle(BKASH).click());
    expect(page?.dirty).toBe(false);
    const down = row(BKASH).querySelector<HTMLButtonElement>('button[aria-label="Move bKash down"]')!;
    expect(down).not.toBeNull();
    await act(async () => down.click());
    expect(page?.dirty).toBe(true);
    await act(async () => { await page!.saveAll(); });
    expect(sdk.postApiV1AdminSettingsPaymentMethods.mock.calls.at(-1)![0].body.enabledMethods).toEqual(["cod", BKASH]);
  });

  it("does not hide a default-method change made when the old default was disabled", async () => {
    sdk.getApiV1AdminSettingsPaymentMethods.mockImplementation(() => envelope({ ...methods([BKASH, "cod"]), defaultMethod: BKASH }));
    await renderCard();
    await act(async () => toggle(BKASH).click());
    await act(async () => toggle(BKASH).click());
    expect(page?.dirty).toBe(true);
    await act(async () => { await page!.saveAll(); });
    expect(sdk.postApiV1AdminSettingsPaymentMethods.mock.calls.at(-1)![0].body).toMatchObject({ enabledMethods: [BKASH, "cod"], defaultMethod: "cod" });
  });

  it("lists a ready app provider beside the built-in gateways, with its app and test mode", async () => {
    await renderCard();

    const bkash = row(BKASH);
    expect(bkash.textContent).toContain("bKash");
    expect(bkash.textContent).toContain("Provided by bKash Payments");
    expect(bkash.textContent).toContain("Off · Test mode");
    expect(toggle(BKASH).disabled).toBe(false);
    // The chip links to the app; Manage opens the method's own page in it.
    const links = [...bkash.querySelectorAll("a")];
    expect(links.map((link) => link.getAttribute("href"))).toEqual(["/admin/apps/scalius.bkash", "/admin/apps/scalius.bangladesh/bkash"]);
    expect(links.map((link) => link.textContent)).toEqual(["Provided by bKash Payments", "Manage"]);
    // The app's icon is the method's mark; an app without one keeps the neutral wallet.
    expect(bkash.querySelector("img")?.getAttribute("src")).toBe("/api/v1/admin/apps/scalius.bkash/assets/icon?v=63a5ccd16b4c0000");
    expect(row(NAGAD).querySelector("img")).toBeNull();
  });

  it("fails an app provider closed with the server's reason, and links to its own page to fix it", async () => {
    await renderCard();

    const nagad = row(NAGAD);
    expect(nagad.textContent).toContain("Activate Nagad in Apps to use it.");
    expect(toggle(NAGAD).disabled).toBe(true);
    const setUp = [...nagad.querySelectorAll("a")].find((link) => link.textContent === "Set up");
    expect(setUp?.getAttribute("href")).toBe("/admin/apps/scalius.bangladesh/nagad");
    // Nothing to test while the app can't run.
    expect([...nagad.querySelectorAll("button")].some((button) => button.textContent === "Test connection")).toBe(false);
  });

  it("turns an app method on and makes it the default with the saved revision", async () => {
    await renderCard();

    await act(async () => toggle(BKASH).click());
    await vi.waitFor(() => expect(page?.dirty).toBe(true));
    await act(async () => { await page!.saveAll(); });

    await vi.waitFor(() => expect(sdk.postApiV1AdminSettingsPaymentMethods).toHaveBeenCalledOnce());
    expect(sdk.postApiV1AdminSettingsPaymentMethods.mock.calls[0]![0].body).toEqual({
      enabledMethods: ["cod", BKASH],
      defaultMethod: "cod",
      expectedRevision: 7,
    });
  });

  it("tests an app provider's connection and shows its answer", async () => {
    sdk.postApiV1AdminSettingsProvidersByIdTest.mockImplementation(() => envelope({ ok: false, message: "bKash rejected the app key." }));
    await renderCard();

    const test = [...row(BKASH).querySelectorAll("button")].find((button) => button.textContent === "Test connection")!;
    await act(async () => test.click());

    await vi.waitFor(() => expect(row(BKASH).querySelector("[role=status]")?.textContent)
      .toBe("Connection failed · bKash rejected the app key."));
    expect(sdk.postApiV1AdminSettingsProvidersByIdTest).toHaveBeenCalledWith({ path: { id: BKASH } });
  });

  it("never shows a removed app's saved method as on, and it never blocks saving", async () => {
    sdk.getApiV1AdminSettingsPaymentMethods.mockImplementation(() => envelope({ ...methods(["cod", "gone.app:wallet"]) }));
    await renderCard();

    expect(container.querySelector('[data-method="gone.app:wallet"]')).toBeNull();
    await act(async () => toggle(BKASH).click());
    await vi.waitFor(() => expect(page?.dirty).toBe(true));
    expect(page?.invalid).toBe(false);
    await act(async () => { await page!.saveAll(); });
    // The API drops it from the saved methods.
    expect(sdk.postApiV1AdminSettingsPaymentMethods).toHaveBeenCalledOnce();
  });

  it("names the default that no longer fits and marks its field when Save is pressed", async () => {
    // The saved default is Nagad, whose app is inactive: checkout can't select it first.
    sdk.getApiV1AdminSettingsPaymentMethods.mockImplementation(() => envelope({ ...methods(["cod", NAGAD]), defaultMethod: NAGAD }));
    await act(async () => {
      root.render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <PermissionProvider isSuperAdmin>
            <SaveScope render={(state) => { page = state; return null; }}>
              <SaveErrorBanner />
              <PaymentMethodsCard />
            </SaveScope>
          </PermissionProvider>
        </QueryClientProvider>,
      );
    });
    await vi.waitFor(() => expect(container.querySelector(`[data-method="${NAGAD}"]`)).not.toBeNull());
    // Any edit that keeps the default: reorder the methods.
    await act(async () => row("cod").querySelector<HTMLButtonElement>('button[aria-label^="Move"]:not([disabled])')!.click());
    expect(page?.dirty).toBe(true);
    expect(page?.invalid).toBe(true);
    expect(page?.problems).toEqual([{ line: "Payment methods: Choose which method is selected first: the current one isn't offered at checkout.", target: "default-payment-method" }]);

    await act(async () => { await page!.saveAll(); });

    expect(sdk.postApiV1AdminSettingsPaymentMethods).not.toHaveBeenCalled();
    const select = document.getElementById("default-payment-method")!;
    expect(select.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(select);
    const banner = container.querySelector("[role=alert]")!;
    expect(banner.textContent).toContain("To save, fix 1 problem");
    expect(banner.textContent).toContain("Selected first at checkout: Choose which method is selected first");
  });
});
