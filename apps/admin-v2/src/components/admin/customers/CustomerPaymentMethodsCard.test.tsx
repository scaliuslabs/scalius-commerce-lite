// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { translate } from "~/i18n";
import { customerPaymentMethodsMessages } from "~/i18n/customer-payment-methods";

const sdk = vi.hoisted(() => ({
  getApiV1AdminCustomersByIdPaymentMethods: vi.fn(),
  deleteApiV1AdminCustomersByIdPaymentMethodsByMethodId: vi.fn(),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("@scalius/api-client/sdk", async (importOriginal) => ({ ...await importOriginal<typeof import("@scalius/api-client/sdk")>(), ...sdk }));
vi.mock("~/lib/toast", () => ({ toast }));
vi.mock("~/contexts/PermissionContext", () => ({ usePermissions: () => ({ hasPermission: () => false }) }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, params, className }: { children: ReactNode; params: { orderId: string }; className?: string }) => (
    <a href={`/admin/orders/${params.orderId}`} className={className}>{children}</a>
  ),
}));

import { CustomerPaymentMethodsCard, paymentMethodExpiry } from "./CustomerPaymentMethodsCard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const t = (key: keyof typeof customerPaymentMethodsMessages.en, vars?: Record<string, string | number>) =>
  translate(customerPaymentMethodsMessages, key, vars);
const ok = <T,>(data: T) => Promise.resolve({ data: { success: true, data }, response: { status: 200 } });

const VISA = {
  id: "cpm_visa", brand: "visa", last4: "4242", expiryMonth: 8, expiryYear: 2099, label: null,
  savedFor: "Subscribe and save", createdAt: "2026-10-01T04:00:00.000Z",
  providerId: "scalius.stripe:card", ownerAppId: "scalius.subscriptions", purchaseOptionId: "po_1", sourceOrderId: "ord_1",
};
const STAFF_ONLY = {
  ...VISA, id: "cpm_staff", brand: "mastercard", last4: "4444", ownerAppId: null, purchaseOptionId: null, savedFor: null, sourceOrderId: null,
};

const buttonNamed = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((element) => element.textContent?.trim() === label);

describe("customer saved payment methods card", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.clearAllMocks();
    notifyManager.setNotifyFunction((callback) => { act(callback); });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    sdk.getApiV1AdminCustomersByIdPaymentMethods.mockImplementation(() => ok({ paymentMethods: [VISA, STAFF_ONLY] }));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = "";
    notifyManager.setNotifyFunction((callback) => callback());
  });

  async function render(canEdit = true, settled = "Visa •••• 4242") {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CustomerPaymentMethodsCard customerId="cus_1" canEdit={canEdit} />
        </QueryClientProvider>,
      );
    });
    await vi.waitFor(() => expect(container.textContent).toContain(settled));
  }

  it("shows each method's card, expiry, what it was kept for, who may charge it and its order", async () => {
    await render();
    expect(sdk.getApiV1AdminCustomersByIdPaymentMethods).toHaveBeenCalledWith({ path: { id: "cus_1" } });
    const [app, staff] = [...container.querySelectorAll("[data-payment-method]")];
    expect(app!.textContent).toContain("Visa •••• 4242");
    expect(app!.textContent).toContain(t("expires", { date: "Aug 2099" }));
    expect(app!.textContent).toContain(t("savedFor", { option: "Subscribe and save" }));
    // Without Apps access the app reads as its id.
    expect(app!.textContent).toContain(t("chargedBy", { app: "scalius.subscriptions" }));
    expect(app!.querySelector("a")?.getAttribute("href")).toBe("/admin/orders/ord_1");
    expect(staff!.textContent).toContain("Mastercard •••• 4444");
    expect(staff!.textContent).toContain(t("staffOnly"));
    expect(staff!.querySelector("a")).toBeNull();
  });

  it("removes a method only after the confirm dialog, then shows what is left", async () => {
    await render();
    sdk.deleteApiV1AdminCustomersByIdPaymentMethodsByMethodId.mockImplementation(() => ok({ paymentMethods: [STAFF_ONLY] }));
    const row = container.querySelector('[data-payment-method="cpm_visa"]')!;
    await act(async () => row.querySelector("button")!.click());
    expect(sdk.deleteApiV1AdminCustomersByIdPaymentMethodsByMethodId).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(t("removeTitle", { method: "Visa •••• 4242" }));
    const confirm = [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find((button) => button.textContent?.trim() === t("remove"))!;
    await act(async () => confirm.click());
    await vi.waitFor(() => expect(container.querySelector('[data-payment-method="cpm_visa"]')).toBeNull());
    expect(sdk.deleteApiV1AdminCustomersByIdPaymentMethodsByMethodId).toHaveBeenCalledWith({ path: { id: "cus_1", methodId: "cpm_visa" } });
    expect(toast.success).toHaveBeenCalledWith(t("removed"));
    expect(container.querySelector('[data-payment-method="cpm_staff"]')).not.toBeNull();
  });

  it("offers no remove without customers.edit", async () => {
    await render(false);
    expect(buttonNamed(t("remove"))).toBeUndefined();
  });

  it("says so when the customer has none", async () => {
    sdk.getApiV1AdminCustomersByIdPaymentMethods.mockImplementation(() => ok({ paymentMethods: [] }));
    await render(true, t("empty"));
    expect(container.querySelectorAll("[data-payment-method]")).toHaveLength(0);
  });

  it("reads a past month as expired", () => {
    const now = new Date("2026-10-21T00:00:00Z");
    const word = (key: keyof typeof customerPaymentMethodsMessages.en, vars?: Record<string, string | number>) => translate(customerPaymentMethodsMessages, key, vars);
    expect(paymentMethodExpiry({ expiryMonth: 9, expiryYear: 2026 }, word, now)?.expired).toBe(true);
    expect(paymentMethodExpiry({ expiryMonth: 10, expiryYear: 2026 }, word, now)?.expired).toBe(false);
    expect(paymentMethodExpiry({ expiryMonth: null, expiryYear: 2026 }, word, now)).toBeNull();
  });
});
