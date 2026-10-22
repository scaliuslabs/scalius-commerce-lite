// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminApiResponseError } from "~/lib/admin-api-error";

const sdk = vi.hoisted(() => ({ postApiV1AdminCustomersByIdErase: vi.fn() }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("@scalius/api-client/sdk", () => sdk);
vi.mock("~/lib/toast", () => ({ toast }));
vi.mock("~/lib/api", () => ({ apiData: (result: Promise<unknown>) => result }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, params, children, ...props }: { to: string; params?: Record<string, string>; children: ReactNode }) => (
    <a href={Object.entries(params ?? {}).reduce((href, [key, value]) => href.replace(`$${key}`, value), to)} {...props}>{children}</a>
  ),
}));

import { CustomerEraseCard } from "./CustomerEraseCard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("the erase personal data dialog", () => {
  let root: Root;
  let host: HTMLDivElement;
  let client: QueryClient;
  beforeEach(async () => {
    vi.clearAllMocks();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    await act(async () => root.render(
      <QueryClientProvider client={client}>
        <CustomerEraseCard customerId="cust_1" name="Rahim Uddin" />
      </QueryClientProvider>,
    ));
  });
  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
  });

  const buttons = (label: string) => [...document.body.querySelectorAll("button")].filter((button) => button.textContent === label);
  const dialog = () => document.body.querySelector('[role="alertdialog"]');
  const open = () => act(async () => buttons("Erase personal data")[0]!.click());
  const type = (value: string) => act(async () => {
    const input = dialog()!.querySelector<HTMLInputElement>("input")!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const eraseButton = () => [...dialog()!.querySelectorAll("button")].find((button) => button.textContent === "Erase personal data")!;

  it("says what is erased and kept, and enables Erase only once the word is typed", async () => {
    await open();
    expect(dialog()?.textContent).toContain("Erase the personal data of “Rahim Uddin”?");
    expect(dialog()?.textContent).toContain("can't be undone");
    expect(dialog()?.textContent).toContain("for your books");
    expect(dialog()?.textContent).toContain("Apps and webhooks are told to erase their own copies.");
    expect(eraseButton().disabled).toBe(true);
    await type("ERAS");
    expect(eraseButton().disabled).toBe(true);
    await type("erase ");
    expect(eraseButton().disabled).toBe(false);
  });

  it("erases, toasts and closes on success", async () => {
    sdk.postApiV1AdminCustomersByIdErase.mockResolvedValue({ customerId: "cust_1", erased: true, mergedRecords: 1, orders: 3, files: 0 });
    const invalidate = vi.spyOn(client, "invalidateQueries");
    await open();
    await type("ERASE");
    await act(async () => eraseButton().click());
    expect(sdk.postApiV1AdminCustomersByIdErase).toHaveBeenCalledWith({ path: { id: "cust_1" } });
    expect(toast.success).toHaveBeenCalledWith("Personal data erased");
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["customers"] });
    expect(dialog()).toBeNull();
  });

  it("shows the open-order refusal inline with a link to the order, and stays open", async () => {
    sdk.postApiV1AdminCustomersByIdErase.mockRejectedValue(new AdminApiResponseError(
      "This customer has an order in progress. Deliver, complete or cancel it before erasing their data.",
      400,
      "validation_error",
      { orderId: "ord_42", orderNumber: 1042 },
    ));
    await open();
    await type("ERASE");
    await act(async () => eraseButton().click());
    // The refusal settles a tick after the click.
    await vi.waitFor(() => expect(dialog()?.textContent).toContain("is still in progress. Deliver, complete or cancel it before erasing."));
    expect(dialog()?.querySelector('a[href="/admin/orders/ord_42"]')).not.toBeNull();
    expect(toast.success).not.toHaveBeenCalled();
  });
});
