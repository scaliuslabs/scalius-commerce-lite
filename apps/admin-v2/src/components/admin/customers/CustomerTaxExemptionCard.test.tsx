// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { translate } from "~/i18n";
import { customerTaxExemptionMessages } from "~/i18n/customer-tax-exemption";

const sdk = vi.hoisted(() => ({ putApiV1AdminCustomersById: vi.fn() }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("@scalius/api-client/sdk", async (importOriginal) => ({ ...await importOriginal<typeof import("@scalius/api-client/sdk")>(), ...sdk }));
vi.mock("~/lib/toast", () => ({ toast }));

import { CustomerTaxExemptionCard } from "./CustomerTaxExemptionCard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const t = (key: keyof typeof customerTaxExemptionMessages.en, vars?: Record<string, string | number>) =>
  translate(customerTaxExemptionMessages, key, vars);
const ok = <T,>(data: T) => Promise.resolve({ data: { success: true, data }, response: { status: 200 } });

const buttonNamed = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((element) => element.textContent?.trim() === label);
const toggle = () => document.getElementById("customer-tax-exempt") as HTMLButtonElement | null;
const numberInput = () => document.getElementById("customer-tax-exemption-id") as HTMLInputElement | null;

async function typeInto(element: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("customer tax exemption card", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.clearAllMocks();
    notifyManager.setNotifyFunction((callback) => { act(callback); });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    sdk.putApiV1AdminCustomersById.mockImplementation(({ body }: { body: { taxExempt: boolean; taxExemptionId: string | null } }) =>
      ok({ customer: { id: "cus_1", taxExempt: body.taxExempt, taxExemptionId: body.taxExemptionId } }));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = "";
    notifyManager.setNotifyFunction((callback) => callback());
  });

  async function render(props: { taxExempt: boolean; taxExemptionId: string | null; canEdit?: boolean }) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CustomerTaxExemptionCard customerId="cus_1" canEdit={props.canEdit ?? true} taxExempt={props.taxExempt} taxExemptionId={props.taxExemptionId} />
        </QueryClientProvider>,
      );
    });
  }

  it("shows the saved state with its number and offers Save only after a change", async () => {
    await render({ taxExempt: true, taxExemptionId: "VAT-123" });
    expect(container.textContent).toContain(t("title"));
    expect(toggle()?.getAttribute("aria-checked")).toBe("true");
    expect(numberInput()?.value).toBe("VAT-123");
    expect(buttonNamed(t("save"))).toBeUndefined();
  });

  it("turns the exemption on with a number and sends both", async () => {
    await render({ taxExempt: false, taxExemptionId: null });
    expect(toggle()?.getAttribute("aria-checked")).toBe("false");
    expect(numberInput()).toBeNull();

    await act(async () => toggle()!.click());
    await typeInto(numberInput()!, "  RC-55  ");
    await act(async () => buttonNamed(t("save"))!.click());

    expect(sdk.putApiV1AdminCustomersById).toHaveBeenCalledWith({
      path: { id: "cus_1" },
      body: { taxExempt: true, taxExemptionId: "RC-55" },
    });
    expect(toast.success).toHaveBeenCalledWith(t("saved"));
  });

  it("sends no number for a blank one", async () => {
    await render({ taxExempt: false, taxExemptionId: null });
    await act(async () => toggle()!.click());
    await act(async () => buttonNamed(t("save"))!.click());
    expect(sdk.putApiV1AdminCustomersById).toHaveBeenCalledWith({
      path: { id: "cus_1" },
      body: { taxExempt: true, taxExemptionId: null },
    });
  });

  it("clears the number when the exemption is turned off", async () => {
    await render({ taxExempt: true, taxExemptionId: "VAT-123" });
    await act(async () => toggle()!.click());
    expect(numberInput()).toBeNull();
    await act(async () => buttonNamed(t("save"))!.click());
    expect(sdk.putApiV1AdminCustomersById).toHaveBeenCalledWith({
      path: { id: "cus_1" },
      body: { taxExempt: false, taxExemptionId: null },
    });
  });

  it("only shows the state without the permission", async () => {
    await render({ taxExempt: true, taxExemptionId: "VAT-123", canEdit: false });
    expect(toggle()).toBeNull();
    expect(numberInput()).toBeNull();
    expect(buttonNamed(t("save"))).toBeUndefined();
    expect(container.textContent).toContain(t("stateExempt"));
    expect(container.textContent).toContain(t("numberLabel", { number: "VAT-123" }));
  });
});
