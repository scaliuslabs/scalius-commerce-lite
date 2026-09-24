// @vitest-environment happy-dom

import { act } from "react";
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
  postApiV1AdminSettingsStripe: vi.fn(),
  postApiV1AdminSettingsSslcommerz: vi.fn(),
  postApiV1AdminSettingsPaymentMethods: vi.fn(),
  deleteApiV1AdminSettingsStripe: vi.fn(),
  deleteApiV1AdminSettingsSslcommerz: vi.fn(),
}));
vi.mock("@scalius/api-client/sdk", () => sdk);
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("../media-manager", () => ({ MediaManager: () => null }));

import { PermissionProvider } from "~/contexts/PermissionContext";
import { SaveScope, type SaveScopeState } from "../shared/SaveBar";
import { PaymentMethodsCard } from "./PaymentsSettings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const envelope = <T,>(data: T) => Promise.resolve({ data: { success: true, data } });
const MASKED = "••••••••••••";

const status = (overrides: Record<string, unknown>) => ({
  configured: true,
  enabled: true,
  usable: true,
  missingFields: [],
  providerEnabled: true,
  checkoutSelected: false,
  environment: "test",
  ...overrides,
});

function methods(stripe: Record<string, unknown>) {
  return {
    enabledMethods: ["cod"],
    defaultMethod: "cod",
    gatewayStatus: {
      cod: status({ environment: "not_applicable", checkoutSelected: true }),
      sslcommerz: status({ configured: false, enabled: false, usable: false, missingFields: ["storeId", "storePassword"], providerEnabled: false }),
      stripe: status(stripe),
    },
  };
}

function type(input: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const button = (label: string) =>
  [...document.querySelectorAll("button")].find((element) => element.textContent?.trim() === label)!;

describe("payment gateway setup", () => {
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
    sdk.getApiV1AdminSettingsCurrency.mockImplementation(() => envelope({ currencyCode: "BDT", currencySymbol: "৳", usdExchangeRate: "1" }));
    sdk.getApiV1AdminSettingsPlatform.mockImplementation(() => envelope({ apiUrl: "https://api.example.com" }));
    sdk.getApiV1AdminSettingsStripe.mockImplementation(() =>
      envelope({ secretKey: MASKED, publishableKey: "", webhookSecret: "", enabled: false }));
    sdk.postApiV1AdminSettingsStripe.mockImplementation(() => envelope({ message: "ok" }));
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
    await vi.waitFor(() => expect(container.textContent).toContain("Stripe"));
  }

  it("says which keys a half-set-up gateway still needs", async () => {
    sdk.getApiV1AdminSettingsPaymentMethods.mockImplementation(() =>
      envelope(methods({ configured: false, enabled: false, usable: false, providerEnabled: false, missingFields: ["publishableKey", "webhookSecret"] })));
    await renderCard();

    expect(container.textContent).toContain("Needs publishable key and webhook secret");
    expect(container.textContent).toContain("Needs store ID and store password");
  });

  it("saves some keys without turning Stripe on", async () => {
    sdk.getApiV1AdminSettingsPaymentMethods.mockImplementation(() =>
      envelope(methods({ configured: false, enabled: false, usable: false, providerEnabled: false, missingFields: ["publishableKey", "webhookSecret"] })));
    await renderCard();

    const setUp = [...container.querySelectorAll("button")].filter((element) => element.textContent === "Set up")[1]!;
    await act(async () => setUp.click());
    const publishable = await vi.waitFor(() => {
      const input = document.querySelector<HTMLInputElement>("#stripe-publishable");
      expect(input).not.toBeNull();
      return input!;
    });
    type(publishable, "pk_test_123");
    await act(async () => button("Save").click());

    await vi.waitFor(() => expect(sdk.postApiV1AdminSettingsStripe).toHaveBeenCalledOnce());
    expect(sdk.postApiV1AdminSettingsStripe.mock.calls[0]![0].body).toMatchObject({ publishableKey: "pk_test_123", enabled: false });
  });

  it("turning Stripe on with keys missing opens its setup and marks the missing keys", async () => {
    sdk.getApiV1AdminSettingsPaymentMethods.mockImplementation(() =>
      envelope(methods({ configured: false, enabled: false, usable: false, providerEnabled: false, missingFields: ["publishableKey", "webhookSecret"] })));
    await renderCard();

    const stripeSwitch = container.querySelector<HTMLButtonElement>('[aria-label="Show Stripe at checkout"]')!;
    expect(stripeSwitch.disabled).toBe(false);
    await act(async () => stripeSwitch.click());

    const dialog = await vi.waitFor(() => {
      const element = document.querySelector("[role=dialog]");
      expect(element?.textContent).toContain("Add the publishable key and webhook secret to turn on Stripe.");
      expect(element?.querySelector("#stripe-publishable")).not.toBeNull();
      return element!;
    });
    // Save with a key still missing marks it next to its field and sends nothing.
    type(dialog.querySelector<HTMLInputElement>("#stripe-publishable")!, "pk_test_123");
    await act(async () => button("Save").click());
    expect(dialog.querySelector("#stripe-webhook-note")?.textContent).toBe("Add the webhook secret to turn on Stripe.");
    expect(dialog.querySelector("#stripe-webhook")?.getAttribute("aria-invalid")).toBe("true");
    expect(dialog.querySelector("#stripe-publishable")?.getAttribute("aria-invalid")).not.toBe("true");
    expect(dialog.querySelector("#stripe-secret-note")?.textContent).toBe("Saved. Type a new value to replace it.");
    expect(sdk.postApiV1AdminSettingsStripe).not.toHaveBeenCalled();

    type(dialog.querySelector<HTMLInputElement>("#stripe-webhook")!, "whsec_123");
    await act(async () => button("Save").click());

    await vi.waitFor(() => expect(sdk.postApiV1AdminSettingsStripe).toHaveBeenCalledOnce());
    expect(sdk.postApiV1AdminSettingsStripe.mock.calls[0]![0].body).toMatchObject({
      publishableKey: "pk_test_123",
      webhookSecret: "whsec_123",
      enabled: true,
    });
    // Stripe is now switched on in the page's unsaved changes.
    await vi.waitFor(() => expect(page?.dirty).toBe(true));
  });

  async function openStripeSetup() {
    sdk.getApiV1AdminSettingsPaymentMethods.mockImplementation(() =>
      envelope(methods({ configured: false, enabled: false, usable: false, providerEnabled: false, missingFields: ["publishableKey", "webhookSecret"] })));
    sdk.getApiV1AdminSettingsStripe.mockImplementation(() =>
      envelope({ secretKey: MASKED, publishableKey: "", webhookSecret: "", enabled: false, revision: 3 }));
    await renderCard();
    const setUp = [...container.querySelectorAll("button")].filter((element) => element.textContent === "Set up")[1]!;
    await act(async () => setUp.click());
    return vi.waitFor(() => {
      const dialog = document.querySelector<HTMLElement>("[role=dialog]");
      expect(dialog?.querySelector("#stripe-secret")).not.toBeNull();
      return dialog!;
    });
  }

  it("shows a saved secret as saved even once the field has focus, and clearing a new value keeps it", async () => {
    const dialog = await openStripeSetup();
    const secret = dialog.querySelector<HTMLInputElement>("#stripe-secret")!;

    act(() => secret.focus());
    expect(secret.value).toBe("");
    expect(secret.placeholder).toBe(MASKED);
    expect(dialog.querySelector("#stripe-secret-note")?.textContent).toBe("Saved. Type a new value to replace it.");
    expect(page?.dirty).toBeFalsy();

    type(secret, "sk_test_new");
    expect(dialog.querySelector("#stripe-secret-note")).toBeNull();
    type(secret, "");
    expect(dialog.querySelector("#stripe-secret-note")?.textContent).toBe("Saved. Type a new value to replace it.");
    expect(button("Save").disabled).toBe(true);
  });

  it("removes Stripe's saved keys after naming the gateway in a confirmation", async () => {
    sdk.deleteApiV1AdminSettingsStripe.mockResolvedValue({ data: { success: true, data: { message: "ok", revision: 4 } }, response: { status: 200 } });
    const dialog = await openStripeSetup();

    await act(async () => button("Remove keys").click());
    const confirm = await vi.waitFor(() => {
      const element = document.querySelector("[role=alertdialog]");
      expect(element?.textContent).toContain("Remove Stripe keys?");
      return element!;
    });
    await act(async () => [...confirm.querySelectorAll("button")].find((element) => element.textContent === "Remove keys")!.click());

    await vi.waitFor(() => expect(sdk.deleteApiV1AdminSettingsStripe).toHaveBeenCalledOnce());
    expect(sdk.deleteApiV1AdminSettingsStripe.mock.calls[0]![0]).toMatchObject({ body: { expectedRevision: 3 } });
    await vi.waitFor(() => expect(dialog.isConnected).toBe(false));
  });

  it("says why Stripe's keys can't be removed while checkout depends on it", async () => {
    sdk.deleteApiV1AdminSettingsStripe.mockResolvedValue({
      error: { success: false, error: { code: "VALIDATION_ERROR", message: "Cannot disable Stripe because…" } },
      response: { status: 400 },
    });
    const dialog = await openStripeSetup();

    await act(async () => button("Remove keys").click());
    const confirm = await vi.waitFor(() => document.querySelector("[role=alertdialog]")!);
    await act(async () => [...confirm.querySelectorAll("button")].find((element) => element.textContent === "Remove keys")!.click());

    await vi.waitFor(() => expect(dialog.querySelector("[role=alert]")?.textContent)
      .toBe("Checkout needs another payment method before Stripe can be removed. Turn one on first."));
    expect(dialog.isConnected).toBe(true);
  });
});
