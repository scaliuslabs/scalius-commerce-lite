// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { defaultScheduler, notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import CheckoutFlowSettings from "./CheckoutFlowSettings";
import { queryKeys } from "~/lib/query-keys";
import { AdminApiResponseError } from "~/lib/admin-api-error";
import type { CheckoutFlowSettingsPayload } from "~/lib/api-functions/settings";

const api = vi.hoisted(() => ({
  get: vi.fn(), update: vi.fn(), payments: vi.fn(), blocker: vi.fn(),
  proceed: vi.fn(), reset: vi.fn(),
}));
vi.mock("~/lib/api-functions/settings", () => ({
  getCheckoutFlowSettings: api.get,
  updateCheckoutFlowSettings: api.update,
  getPaymentMethods: api.payments,
}));
vi.mock("@tanstack/react-router", () => ({ useBlocker: api.blocker }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const base: CheckoutFlowSettingsPayload = {
  guestCheckoutEnabled: true, checkoutMode: "all", partialPaymentEnabled: false,
  partialPaymentAmount: 150, revision: 1,
};
const savedCod: CheckoutFlowSettingsPayload = { ...base, checkoutMode: "guest_cod_only", revision: 2 };
const readiness = {
  issues: [], hasUsableCustomerSignIn: true,
  hasActiveShippingMethod: true, hasActiveDeliveryHierarchy: true,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

describe("CheckoutFlowSettings save acknowledgment", () => {
  let host: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.resetAllMocks();
    notifyManager.setNotifyFunction((callback) => { act(callback); });
    notifyManager.setScheduler(queueMicrotask);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(queryKeys.settings.checkoutFlow(), base);
    queryClient.setQueryData(queryKeys.settings.checkoutReadiness(), readiness);
    api.blocker.mockReturnValue({ status: "idle", proceed: api.proceed, reset: api.reset });
    api.get.mockResolvedValue(base);
    api.payments.mockResolvedValue({
      enabledMethods: ["cod", "sslcommerz"],
      gatewayStatus: {
        cod: { enabled: true, configured: true, usable: true },
        sslcommerz: { enabled: true, configured: true, usable: true },
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ success: true, data: readiness })));
  });

  afterEach(() => {
    act(() => root.unmount());
    queryClient.clear();
    document.body.innerHTML = "";
    notifyManager.setNotifyFunction((callback) => callback());
    notifyManager.setScheduler(defaultScheduler);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function radio(mode: string) {
    return host.querySelector<HTMLButtonElement>(`#checkout-mode-${mode}`)!;
  }
  function button(label: string) {
    return Array.from(document.querySelectorAll("button")).find((item) => item.textContent?.trim() === label)!;
  }
  function expectProtected(protectedState: boolean) {
    const guard = api.blocker.mock.calls.at(-1)![0];
    expect(guard.enableBeforeUnload).toBe(protectedState);
    expect(guard.shouldBlockFn({
      current: { pathname: "/admin/settings/checkout" }, next: { pathname: "/admin/orders" },
    })).toBe(protectedState);
  }
  async function click(target: HTMLElement) {
    await act(async () => { target.click(); });
  }
  async function render() {
    await act(async () => {
      root.render(<QueryClientProvider client={queryClient}><CheckoutFlowSettings /></QueryClientProvider>);
    });
    await vi.waitFor(() => expect(host.textContent).toContain("Checkout flow is saved · revision 1"));
  }
  async function startSave(guestCheckoutEnabled = true) {
    const save = deferred<CheckoutFlowSettingsPayload>();
    api.update.mockReturnValueOnce(save.promise);
    await render();
    if (!guestCheckoutEnabled) await click(host.querySelector("#guest-checkout")!);
    await click(radio("guest_cod_only"));
    await vi.waitFor(() => expect(button("Save checkout flow").disabled).toBe(false));
    await click(button("Save checkout flow"));
    expect(api.update).toHaveBeenCalledWith({ data: {
      guestCheckoutEnabled, checkoutMode: "guest_cod_only", partialPaymentEnabled: false,
      partialPaymentAmount: 150, expectedRevision: 1,
    } });
    expect(button("Reset").disabled).toBe(true);
    return save;
  }
  async function acknowledge(save: ReturnType<typeof deferred<CheckoutFlowSettingsPayload>>, saved = savedCod) {
    const acknowledgments = vi.mocked(toast.success).mock.calls.length;
    api.get.mockResolvedValue(saved);
    await act(async () => {
      save.resolve(saved);
      await vi.waitFor(() => expect(toast.success).toHaveBeenCalledTimes(acknowledgments + 1));
    });
    expect(toast.success).toHaveBeenLastCalledWith("Checkout flow saved");
  }

  it.each(["gateways_only", "all"] as const)("keeps a newer %s choice through cache arrival and saves it using the acknowledged revision", async (newerMode) => {
    const save = await startSave();
    expect(radio(newerMode).disabled).toBe(false);
    expect(host.querySelector<HTMLButtonElement>("#guest-checkout")!.disabled).toBe(false);
    expect(host.querySelector<HTMLButtonElement>("#advance-payment")!.disabled).toBe(false);
    await click(radio(newerMode));
    const canonical = { ...savedCod, guestCheckoutEnabled: false, partialPaymentAmount: 175 };
    await act(async () => { queryClient.setQueryData(queryKeys.settings.checkoutFlow(), canonical); });
    expect(radio(newerMode).getAttribute("data-state")).toBe("checked");
    expectProtected(true);

    await acknowledge(save, canonical);
    expect(radio(newerMode).getAttribute("data-state")).toBe("checked");
    expect(host.querySelector("#guest-checkout")!.getAttribute("data-state")).toBe("unchecked");
    expect(host.textContent).toContain("Unsaved checkout changes · based on revision 2");
    expect(button("Save checkout flow").disabled).toBe(false);
    expectProtected(true);

    const secondSaved = { ...canonical, checkoutMode: newerMode, revision: 3 };
    const secondSave = deferred<CheckoutFlowSettingsPayload>();
    api.update.mockReturnValueOnce(secondSave.promise);
    await click(button("Save checkout flow"));
    expect(api.update).toHaveBeenLastCalledWith({ data: {
      guestCheckoutEnabled: false, checkoutMode: newerMode, partialPaymentEnabled: false,
      partialPaymentAmount: 175, expectedRevision: 2,
    } });
    await acknowledge(secondSave, secondSaved);
    expect(host.textContent).toContain("Checkout flow is saved · revision 3");
    expectProtected(false);
  });

  it("resets a later edit to the canonical acknowledgment", async () => {
    const save = await startSave();
    await click(radio("gateways_only"));
    const canonical = { ...savedCod, guestCheckoutEnabled: false };
    await acknowledge(save, canonical);
    expect(button("Reset").disabled).toBe(false);
    await click(button("Reset"));
    expect(radio("guest_cod_only").getAttribute("data-state")).toBe("checked");
    expect(host.querySelector("#guest-checkout")!.getAttribute("data-state")).toBe("unchecked");
    expect(host.textContent).toContain("Checkout flow is saved · revision 2");
    expect(button("Save checkout flow").disabled).toBe(true);
    expectProtected(false);
  });

  it("keeps pending navigation guarded and cancels it when an unchanged save is acknowledged", async () => {
    const save = await startSave();
    expectProtected(true);
    await act(async () => {
      host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(api.update).toHaveBeenCalledTimes(1);
    api.blocker.mockReturnValue({ status: "blocked", proceed: api.proceed, reset: api.reset });
    await act(async () => {
      root.render(<QueryClientProvider client={queryClient}><CheckoutFlowSettings /></QueryClientProvider>);
    });
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
    expect(api.reset).not.toHaveBeenCalled();
    await acknowledge(save);
    expectProtected(false);
    expect(api.reset).toHaveBeenCalledTimes(1);
    expect(api.proceed).not.toHaveBeenCalled();
  });

  it("preserves the draft and saved revision when a save fails", async () => {
    const save = await startSave();
    await click(radio("gateways_only"));
    await act(async () => { save.reject(new Error("Save unavailable")); });
    expect(toast.error).toHaveBeenCalled();
    expect(radio("gateways_only").getAttribute("data-state")).toBe("checked");
    expect(host.textContent).toContain("Unsaved checkout changes · based on revision 1");
    expect(button("Save checkout flow").disabled).toBe(false);
    expect(queryClient.getQueryData(queryKeys.settings.checkoutFlow())).toEqual(base);
    expectProtected(true);
  });

  it("keeps a post-submit revert after failure while adopting a newer authoritative cache read", async () => {
    const save = await startSave();
    await click(radio("all"));
    const latest = { ...savedCod, guestCheckoutEnabled: false };
    await act(async () => { queryClient.setQueryData(queryKeys.settings.checkoutFlow(), latest); });
    await act(async () => { save.reject(new Error("Save unavailable")); });
    expect(toast.error).toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    expect(radio("all").getAttribute("data-state")).toBe("checked");
    expect(host.querySelector("#guest-checkout")!.getAttribute("data-state")).toBe("unchecked");
    expect(host.textContent).toContain("Unsaved checkout changes · based on revision 2");
    expect(button("Save checkout flow").disabled).toBe(false);
    expect(queryClient.getQueryData(queryKeys.settings.checkoutFlow())).toEqual(latest);
    expectProtected(true);
  });

  it("preserves a reverted draft through a revision conflict until the merchant chooses the latest version", async () => {
    const save = await startSave();
    await click(radio("all"));
    await act(async () => { queryClient.setQueryData(queryKeys.settings.checkoutFlow(), savedCod); });
    api.get.mockResolvedValue(savedCod);
    await act(async () => { save.reject(new AdminApiResponseError(
      "Checkout flow changed", 409, "CHECKOUT_FLOW_REVISION_CONFLICT",
      { expectedRevision: 1, currentRevision: 2 },
    )); });
    await vi.waitFor(() => expect(button("Use latest saved version")).toBeDefined());
    expect(radio("all").getAttribute("data-state")).toBe("checked");
    expect(button("Save checkout flow").disabled).toBe(true);
    expect(host.textContent).toContain("Your unsaved values are still here");
    expectProtected(true);
    await click(button("Use latest saved version"));
    expect(radio("guest_cod_only").getAttribute("data-state")).toBe("checked");
    expect(host.textContent).toContain("Checkout flow is saved · revision 2");
    expectProtected(false);
  });

  it.each([
    { newerMode: "all", retry: true },
    { newerMode: "guest_cod_only", retry: false },
    { newerMode: "gateways_only", retry: false },
  ] as const)("merges earlier edits and the later $newerMode choice through a conflict (retry=$retry)", async ({ newerMode, retry }) => {
    const save = await startSave(false);
    await click(radio(newerMode));
    const latest = { ...savedCod, partialPaymentAmount: 175 };
    if (retry) api.get.mockRejectedValueOnce(new Error("Latest settings unavailable"));
    api.get.mockResolvedValue(latest);
    await act(async () => { save.reject(new AdminApiResponseError(
      "Checkout flow changed", 409, "CHECKOUT_FLOW_REVISION_CONFLICT",
      { expectedRevision: 1, currentRevision: 2 },
    )); });
    if (retry) {
      expect(host.textContent).toContain("The latest version could not be loaded");
      expect(radio(newerMode).getAttribute("data-state")).toBe("checked");
      await click(button("Load latest version"));
    }
    await click(button("Merge my changes"));
    expect(radio(newerMode).getAttribute("data-state")).toBe("checked");
    expect(host.querySelector("#guest-checkout")!.getAttribute("data-state")).toBe("unchecked");
    expect(host.textContent).toContain("Unsaved checkout changes · based on revision 2");
    expectProtected(true);

    const secondSaved = { ...latest, checkoutMode: newerMode, guestCheckoutEnabled: false, revision: 3 };
    const secondSave = deferred<CheckoutFlowSettingsPayload>();
    api.update.mockReturnValueOnce(secondSave.promise);
    await click(button("Save checkout flow"));
    expect(api.update).toHaveBeenLastCalledWith({ data: {
      guestCheckoutEnabled: false, checkoutMode: newerMode, partialPaymentEnabled: false,
      partialPaymentAmount: 175, expectedRevision: 2,
    } });
    await acknowledge(secondSave, secondSaved);
    expect(host.textContent).toContain("Checkout flow is saved · revision 3");
    expectProtected(false);
  });

  it.each([false, true])("refreshes the saved flow while preserving an ordinary dirty=%s draft", async (dirty) => {
    await render();
    if (dirty) await click(radio("gateways_only"));
    await act(async () => {
      queryClient.setQueryData(queryKeys.settings.checkoutFlow(), { ...base, guestCheckoutEnabled: false, revision: 2 });
    });
    expect(radio(dirty ? "gateways_only" : "all").getAttribute("data-state")).toBe("checked");
    expect(host.querySelector("#guest-checkout")!.getAttribute("data-state")).toBe(dirty ? "checked" : "unchecked");
    expect(host.textContent).toContain(dirty
      ? "Unsaved checkout changes · based on revision 1"
      : "Checkout flow is saved · revision 2");
    expectProtected(dirty);
    expect(api.update).not.toHaveBeenCalled();
  });
});
